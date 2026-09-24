import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CliError } from "../errors.js";
import { buildPackageName, currentPlatformArch } from "./builds.js";
import { extractTarball } from "./extract.js";
import { verifyIntegrity } from "./integrity.js";
import { renderProgress, type ProgressEvent } from "./progress.js";

export interface BootstrapOptions {
  registry?: string;
  fetchImpl?: typeof fetch;
  /** Override platform package name (tests). */
  packageName?: string;
  onProgress?: (event: ProgressEvent) => void;
  env?: NodeJS.ProcessEnv;
}

export interface BootstrapResult {
  version: string;
  path: string;
}

function defaultRegistry(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.NYLORUN_REGISTRY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  return "https://registry.npmjs.org";
}

/**
 * One-time download when no Runtime build is installed (D§10).
 * Writes only under `runtime/.download-*`; removes it whatever the result.
 */
export async function bootstrap(
  home: string,
  version: string,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const env = options.env ?? process.env;
  const registry = options.registry ?? defaultRegistry(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const current = currentPlatformArch();
  const name = options.packageName ?? buildPackageName(current);
  const onProgress =
    options.onProgress ??
    ((event: ProgressEvent) => {
      renderProgress(event);
    });

  const runtimeRoot = join(home, "runtime");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const staging = join(
    runtimeRoot,
    `.download-${randomBytes(8).toString("hex")}`,
  );
  await mkdir(staging, { recursive: true, mode: 0o700 });

  try {
    const encoded = name.replace("/", "%2f");
    const metaUrl = `${registry.replace(/\/$/, "")}/${encoded}/${version}`;
    onProgress({ type: "progress", phase: "download" });
    let metaResponse: Response;
    try {
      metaResponse = await fetchImpl(metaUrl, {
        headers: { accept: "application/json" },
      });
    } catch (error) {
      throw new CliError(
        `Failed to fetch ${metaUrl}: ${error instanceof Error ? error.message : String(error)}`,
        1,
      );
    }
    if (!metaResponse.ok) {
      throw new CliError(
        `Registry returned ${metaResponse.status} for ${metaUrl}.`,
        1,
      );
    }
    const body = (await metaResponse.json()) as {
      dist?: { tarball?: string; integrity?: string };
    };
    const tarballUrl = body.dist?.tarball;
    const integrity = body.dist?.integrity;
    if (!tarballUrl || !integrity) {
      throw new CliError(
        `Registry metadata for ${name}@${version} is missing dist.tarball or dist.integrity.`,
        1,
      );
    }

    const tarballPath = join(staging, "build.tgz");
    await downloadToFile(tarballUrl, tarballPath, fetchImpl, onProgress);
    onProgress({ type: "progress", phase: "verify" });
    await verifyIntegrity(tarballPath, integrity);
    onProgress({ type: "progress", phase: "extract" });
    await extractTarball(tarballPath, staging);

    const launcherName =
      current.platform === "win32" ? "nylorun-runtime.cmd" : "nylorun-runtime";
    const launcherBin = join(staging, "bin", launcherName);
    onProgress({ type: "progress", phase: "install" });
    const installResult = await runExtractedInstall(
      launcherBin,
      home,
      version,
      staging,
      env,
      onProgress,
    );

    return {
      version: installResult.version ?? version,
      path: installResult.path ?? join(runtimeRoot, version),
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadToFile(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
  onProgress: (event: ProgressEvent) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new CliError(
      `Failed to download ${url}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  if (!response.ok || !response.body) {
    throw new CliError(`Download failed with status ${response.status}.`, 1);
  }
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress({
        type: "progress",
        phase: "download",
        received,
        ...(total !== undefined && Number.isFinite(total) ? { total } : {}),
      });
    }
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  await writeFile(dest, buffer, { mode: 0o600 });
}

async function runExtractedInstall(
  launcherBin: string,
  home: string,
  version: string,
  extracted: string,
  env: NodeJS.ProcessEnv,
  onProgress: (event: ProgressEvent) => void,
): Promise<{ version?: string; path?: string }> {
  const args = [
    "--json",
    "--home",
    home,
    "install",
    version,
    "--from",
    extracted,
  ];
  const child = spawn(launcherBin, args, {
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  let result: { version?: string; path?: string } | undefined;
  let errorMessage: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: string; [k: string]: unknown };
    try {
      event = JSON.parse(trimmed) as { type?: string; [k: string]: unknown };
    } catch {
      continue;
    }
    if (event.type === "progress") {
      onProgress(event as ProgressEvent);
    } else if (event.type === "result") {
      result = {
        ...(typeof event.version === "string" ? { version: event.version } : {}),
        ...(typeof event.path === "string" ? { path: event.path } : {}),
      };
    } else if (event.type === "error") {
      errorMessage =
        typeof event.message === "string"
          ? event.message
          : "Runtime install failed during bootstrap.";
    }
  }

  if (exitCode !== 0) {
    throw new CliError(
      errorMessage ??
        `Bootstrap install failed (exit ${exitCode}).${stderr ? `\n${stderr.trim()}` : ""}`,
      1,
    );
  }
  return result ?? {};
}

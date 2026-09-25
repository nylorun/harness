import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { integrityOfBuffer } from "../../../src/launcher/integrity.js";
import { writeFakeBuild } from "./fake-build.js";

export async function temporaryRoot(
  prefix = "nylorun-launcher-",
): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeRoot(root: string): Promise<void> {
  // Windows Host/node.exe can briefly lock files under the home after down().
  try {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (
      process.platform === "win32" &&
      (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")
    ) {
      return;
    }
    throw error;
  }
}

export function currentPlatformArch(): {
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
} {
  const platform =
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
      ? process.platform
      : "linux";
  const arch =
    process.arch === "arm64" || process.arch === "x64" ? process.arch : "x64";
  return { platform, arch };
}

/** Pack a fake build as an npm-style tarball (`package/` root). */
export async function packFakeBuildTarball(
  buildDir: string,
  tarballPath: string,
): Promise<{ integrity: string; bytes: Buffer }> {
  const staging = await mkdtemp(join(tmpdir(), "nylorun-pack-"));
  try {
    const packageDir = join(staging, "package");
    await cp(buildDir, packageDir, { recursive: true });
    // Relative archive name + cwd=staging: GNU tar on Windows never sees `C:\...`
    // (it treats `C:` as a remote host → "Cannot connect to C: resolve failed").
    const archiveName = "package.tgz";
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tar", ["-czf", archiveName, "package"], {
        cwd: staging,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`tar pack failed: ${stderr}`)),
      );
    });
    await mkdir(dirname(tarballPath), { recursive: true });
    await cp(join(staging, archiveName), tarballPath);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const bytes = readFileSync(tarballPath);
  return { integrity: integrityOfBuffer(bytes), bytes };
}

/**
 * Tiny local registry serving one Runtime build package (no network).
 */
export async function startFakeRegistry(options: {
  version: string;
  buildDir: string;
  /** When set, advertise this integrity instead of the real one. */
  integrityOverride?: string;
}): Promise<{
  url: string;
  close: () => Promise<void>;
  tarballPath: string;
  integrity: string;
}> {
  const root = await temporaryRoot("nylorun-registry-");
  const tarballPath = join(root, "build.tgz");
  const { integrity: realIntegrity } = await packFakeBuildTarball(
    options.buildDir,
    tarballPath,
  );
  const integrity = options.integrityOverride ?? realIntegrity;
  const { platform, arch } = currentPlatformArch();
  const name = `@nylorun/runtime-${platform}-${arch}`;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const encoded = name.replace("/", "%2f");
    if (url.pathname === `/${encoded}/${options.version}`) {
      const address = server.address();
      const port =
        address && typeof address !== "string" ? address.port : 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name,
          version: options.version,
          dist: {
            tarball: `http://127.0.0.1:${port}/tarball.tgz`,
            integrity,
          },
        }),
      );
      return;
    }
    if (url.pathname === "/tarball.tgz") {
      const bytes = readFileSync(tarballPath);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
      });
      res.end(bytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake registry failed to bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    tarballPath,
    integrity: realIntegrity,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await removeRoot(root);
    },
  };
}

export { writeFakeBuild };

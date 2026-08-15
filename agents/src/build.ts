import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build, loadConfigFromFile } from "vite";
import { diagnostic, NyloBuildError } from "./diagnostics.js";
import type { BuildOptions, BuildResult, CapabilityManifest, FolderDiagnostic } from "./types.js";
import { validateAgent } from "./validate.js";

function fromError(error: unknown): FolderDiagnostic {
  if (error instanceof NyloBuildError) return error.diagnostic;
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(NYLO_BUILD_[A-Z_]+):\s*(.*)/);
  if (match) return diagnostic(match[1], "build", "error", "agent", match[2], "Correct the named build error and retry.");
  return diagnostic("NYLO_BUILD_FAILED", "build", "error", ".", message, "Review the Vite error and the project modules it names.");
}

export async function buildAgent(projectRoot: string, options: BuildOptions = {}): Promise<BuildResult> {
  const root = resolve(projectRoot);
  const checked = await validateAgent(root);
  const checkErrors = checked.diagnostics.filter((item) => item.severity === "error");
  if (checkErrors.length) return Object.freeze({ ok: false, diagnostics: checked.diagnostics });
  try {
    const configPath = join(root, "vite.config.ts");
    const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, configPath, root);
    if (!loaded?.config.plugins || !loaded.config.plugins.some((plugin) => plugin && typeof plugin === "object" && "name" in plugin && plugin.name === "nylo:agent")) {
      return Object.freeze({ ok: false, diagnostics: [...checked.diagnostics, diagnostic("NYLO_BUILD_PLUGIN_MISSING", "build", "error", "vite.config.ts", "The Nylo Vite plugin is missing or did not execute.", "Add nyloAgent() to the Vite plugins array.")] });
    }
    await build({ root, configFile: configPath, logLevel: "silent" });
    const manifestPath = join(root, "dist", "nylo.manifest.json");
    const bundlePath = join(root, "dist", "agent.mjs");
    let manifest: CapabilityManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CapabilityManifest;
      await readFile(bundlePath);
    } catch {
      return Object.freeze({ ok: false, diagnostics: [...checked.diagnostics, diagnostic("NYLO_BUILD_PLUGIN_OUTPUT_OVERRIDDEN", "build", "error", "vite.config.ts", "The Nylo plugin ran, but its required output is missing or malformed.", "Remove build settings that override agent.mjs or nylo.manifest.json.")] });
    }
    if (options.mode === "check") await rm(join(root, "dist"), { recursive: true, force: true });
    return Object.freeze({ ok: true, diagnostics: checked.diagnostics, manifest, outputs: Object.freeze(["dist/agent.mjs", "dist/nylo.manifest.json"]) });
  } catch (error) {
    return Object.freeze({ ok: false, diagnostics: [...checked.diagnostics, fromError(error)] });
  }
}

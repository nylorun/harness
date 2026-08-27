import { unwatchFile, watchFile } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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
    // Vite is loaded on demand rather than at module scope, and declared an *optional* peer: the
    // export barrel is imported by runtime callers — the Agent Runtime among them — that never
    // build anything, and forcing a bundler into their dependency tree would be a real cost.
    // Building without it is a legible refusal rather than a module-resolution stack trace.
    let vite: typeof import("vite");
    try {
      vite = await import("vite");
    } catch {
      return Object.freeze({
        ok: false,
        diagnostics: [
          ...checked.diagnostics,
          diagnostic(
            "NYLO_BUILD_VITE_MISSING",
            "build",
            "error",
            "package.json",
            "Building an agent requires Vite, which is not installed.",
            "Add vite to the project's devDependencies (the scaffold does this for you)."
          )
        ]
      });
    }
    const { build, loadConfigFromFile } = vite;
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

export type AgentBuildWatcher = Readonly<{
  initial: Promise<BuildResult>;
  close(): Promise<void>;
}>;

/**
 * Watches an agent's Vite build. The initial build is exposed separately so a
 * caller can establish its first runtime before it responds to later edits.
 * Runtime deliberately knows nothing about Studio or HTTP lifecycle policy.
 */
export async function watchAgent(
  projectRoot: string,
  onRebuild: (result: BuildResult) => void | Promise<void>
): Promise<AgentBuildWatcher> {
  const root = resolve(projectRoot);
  // Build once before creating the watcher. Vite can complete a watcher's first
  // cycle before `build()` resolves, so treating that cycle as initialization is
  // racy; the one-shot build gives callers a deterministic first artifact.
  const initial = await buildAgent(root);
  if (!initial.ok) return Object.freeze({ initial: Promise.resolve(initial), close: async () => {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rebuilding = false;
  let queued = false;
  let watchedPaths: string[] = [];
  const watchedInputs = async (directory: string): Promise<string[]> => {
    try {
      const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
      const nested = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => watchedInputs(join(directory, entry.name))));
      return [directory, ...entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name)), ...nested.flat()];
    } catch { return []; }
  };
  const rebuild = async (): Promise<void> => {
    if (rebuilding) { queued = true; return; }
    rebuilding = true;
    try {
      await onRebuild(await buildAgent(root));
    } catch (error) {
      await onRebuild(Object.freeze({ ok: false, diagnostics: [...initial.diagnostics, fromError(error)] }));
    } finally {
      rebuilding = false;
      await resetWatchers();
      if (queued) { queued = false; void rebuild(); }
    }
  };
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void rebuild(); }, 75);
  };
  const resetWatchers = async (): Promise<void> => {
    for (const path of watchedPaths) unwatchFile(path);
    watchedPaths = [join(root, "vite.config.ts"), join(root, "package.json"), ...await watchedInputs(join(root, "agent"))];
    for (const path of watchedPaths) watchFile(path, { interval: 250, persistent: false }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) schedule();
    });
  };
  await resetWatchers();
  return Object.freeze({
    initial: Promise.resolve(initial),
    close: async () => { if (timer !== undefined) clearTimeout(timer); for (const path of watchedPaths) unwatchFile(path); }
  });
}

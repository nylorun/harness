#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SDK_VERSION } from "../manifest.js";
import { diagnostic, NyloBuildError } from "../diagnostics.js";
import { buildAgent } from "../build.js";
import { validateAgent } from "../validate.js";
import { createFileRecorder } from "../runtime/record-store.js";
import { renderDiagnostic, styleFor } from "../runtime/render.js";
import type { BuiltAgent } from "../runtime/bind.js";
import type { CapabilityManifest, FolderDiagnostic } from "../types.js";
import { isFailure, parseArgs, USAGE, type Args } from "./args.js";
import { runServe } from "./serve.js";
import { runRecords } from "./runs.js";
import { runPublish } from "./publish.js";
import { runAdapterProbe } from "./adapter.js";
import { runtimeAgentFrom } from "./artifact.js";

/** One envelope shape for every command, so a coding agent parses one thing rather than seven. */
export function envelope(command: string, ok: boolean, data: unknown, diagnostics: readonly FolderDiagnostic[] = []): string {
  const body: Record<string, unknown> = { command, ok };
  if (data !== undefined) body.data = data;
  if (diagnostics.length > 0) body.diagnostics = diagnostics;
  return `${JSON.stringify(body)}\n`;
}

/**
 * Imports the runtime handle the project's build produced. The bundle's default export is the
 * fetch-compatible hosted door; the named `agent` export is the handle used by local CLI commands.
 */
export async function importAgent(args: Args): Promise<BuiltAgent> {
  const project = resolve(args.project);
  const bundle = join(project, "dist", "agent.mjs");
  let module: { agent?: BuiltAgent };
  try {
    module = (await import(pathToFileURL(bundle).href)) as { agent?: BuiltAgent };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      throw new NyloBuildError(
        diagnostic(
          "NYLO_RUN_ARTIFACT_MISSING",
          "run",
          "error",
          "dist/agent.mjs",
          "The built artifact dist/agent.mjs is missing or unreadable.",
          "Run `nylo build`; nothing here builds on your behalf."
        )
      );
    }
    throw error;
  }

  const agent = runtimeAgentFrom(module);
  if (agent === undefined) {
    throw new NyloBuildError(
      diagnostic(
        "NYLO_RUN_ARTIFACT_INVALID",
        "run",
        "error",
        "dist/agent.mjs",
        "The built bundle does not export an agent runtime handle.",
        "Rebuild the project."
      )
    );
  }

  return agent.withHost({
    strict: args.strict,
    recorder: createFileRecorder({
      projectRoot: project,
      redact: collectSecrets(),
      onError: (error) =>
        process.stderr.write(
          `${styleFor(process.stderr.isTTY === true).dim(`recording unavailable: ${error.message}`)}\n`
        )
    })
  });
}

/**
 * Everything in the environment that looks like a credential. Over-inclusive on purpose: the cost
 * of redacting one value too many is a less readable record, and the cost of one too few is a
 * credential on disk.
 */
function collectSecrets(): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || value.length < 8) continue;
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) values.push(value);
  }
  return values;
}

export async function readManifest(project: string): Promise<CapabilityManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(project, "dist", "nylo.manifest.json"), "utf8")) as CapabilityManifest;
  } catch {
    return undefined;
  }
}

async function runCheck(args: Args): Promise<number> {
  const style = styleFor(process.stdout.isTTY === true && !args.json);
  const result = await validateAgent(resolve(args.project), { strict: args.strict });
  if (args.json) {
    process.stdout.write(envelope("check", result.ok, { project: resolve(args.project) }, result.diagnostics));
  } else {
    for (const item of result.diagnostics) process.stderr.write(`${renderDiagnostic(item, style)}\n`);
    if (result.ok) process.stdout.write(`${style.bold("check passed")} ${style.dim("— structure only; run your type checker for the definition")}\n`);
  }
  return result.ok ? 0 : 1;
}

async function runBuild(args: Args): Promise<number> {
  const style = styleFor(process.stdout.isTTY === true && !args.json);
  if (!args.json && !args.yes && process.stdin.isTTY === true) {
    process.stdout.write(
      `${style.dim("building runs this project's own code — vite.config.ts, agent/agent.ts and every tool module — with your authority")}\n`
    );
  }
  const result = await buildAgent(resolve(args.project), args.check ? { mode: "check" } : {});
  if (args.json) {
    process.stdout.write(
      envelope("build", result.ok, { outputs: result.outputs ?? [], manifest: result.manifest }, result.diagnostics)
    );
  } else {
    for (const item of result.diagnostics) process.stderr.write(`${renderDiagnostic(item, style)}\n`);
    if (result.ok) {
      for (const output of result.outputs ?? []) process.stdout.write(`${style.dim("wrote")} ${output}\n`);
    }
  }
  return result.ok ? 0 : 1;
}

async function dispatch(args: Args): Promise<number> {
  switch (args.command) {
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "version":
      process.stdout.write(args.json ? envelope("version", true, { version: SDK_VERSION }) : `${SDK_VERSION}\n`);
      return 0;
    case "check":
      return runCheck(args);
    case "build":
      return runBuild(args);
    case "serve":
      return runServe(args);
    case "runs":
      return runRecords(args);
    case "publish":
      return runPublish(args);
    case "adapter":
      return runAdapterProbe(args);
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (isFailure(parsed)) {
    const style = styleFor(process.stderr.isTTY === true);
    process.stderr.write(`${style.red("error")} ${parsed.error}\n${style.dim(parsed.hint)}\n`);
    return 2;
  }
  // A positional path is the same thing as --project for the commands that take one.
  const withPath =
    (parsed.command === "check" || parsed.command === "build") && parsed.positionals[0] !== undefined
      ? ({ ...parsed, project: parsed.positionals[0], positionals: [] } as Args)
      : parsed;
  return dispatch(withPath);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const style = styleFor(process.stderr.isTTY === true);
    if (error instanceof NyloBuildError) {
      process.stderr.write(`${renderDiagnostic(error.diagnostic, style)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${style.red("error")} ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });

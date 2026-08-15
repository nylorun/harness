#!/usr/bin/env node
import { NyloBuildError } from "../diagnostics.js";
import type { SessionEvent } from "../session/index.js";
import { openAgent } from "./open.js";
import { renderDiagnostic, renderEvent, renderFooter, renderHeader, styleFor } from "./render.js";

const USAGE = `nylo-run — run a built Nylo agent locally

  nylo-run [input] [--json] [--strict] [--project <dir>]

Reads dist/agent.mjs and dist/nylo.manifest.json; it does not build.
With no input on a terminal, reads one line from stdin.

A temporary binary: superseded by "nylo dev" when the CLI ships.`;

type Options = {
  input?: string;
  json: boolean;
  strict: boolean;
  project: string;
};

export function parseArgs(argv: readonly string[]): Options | "help" {
  const options: Options = { json: false, strict: false, project: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return "help";
    else if (arg === "--json") options.json = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--project") options.project = argv[++index] ?? options.project;
    else if (!arg.startsWith("-") && options.input === undefined) options.input = arg;
  }
  return options;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const style = styleFor(process.stdout.isTTY === true && !parsed.json);
  let input = parsed.input;
  if (input === undefined) {
    // Without a terminal there is nobody to prompt, so an absent input is a usage error, not a wait.
    if (process.stdin.isTTY) {
      process.stdout.write("input> ");
      input = await readStdin();
    } else {
      input = await readStdin();
    }
  }
  if (input === undefined || input.trim() === "") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  // Documented testing override: points the resolved provider at a local stub so a run can be
  // exercised end to end without a real credential or outbound network.
  const baseUrl = process.env.NYLO_PROVIDER_BASE_URL;
  const agent = await openAgent(parsed.project, {
    strict: parsed.strict,
    ...(baseUrl === undefined || baseUrl === "" ? {} : { baseUrl })
  });

  for (const item of agent.diagnostics) {
    if (parsed.json) process.stdout.write(`${JSON.stringify({ type: "diagnostic", ...item })}\n`);
    else process.stderr.write(`${renderDiagnostic(item, style)}\n`);
  }

  if (!parsed.json) {
    process.stdout.write(
      `${renderHeader(
        {
          name: agent.config.name,
          model: agent.config.model,
          digest: agent.manifest.digest,
          ...(agent.model === undefined ? {} : { resolved: agent.model })
        },
        style
      )}\n`
    );
  }

  const run = agent.run(input);
  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    // Cancel, then let the loop drain its remaining events so the record of the run stays complete.
    run.cancel("interrupted");
  };
  process.on("SIGINT", onSigint);

  let pendingNewline = false;
  try {
    for await (const event of run.events) {
      if (parsed.json) {
        process.stdout.write(`${JSON.stringify(event satisfies SessionEvent)}\n`);
        continue;
      }
      const rendered = renderEvent(event, style);
      if (rendered === undefined) continue;
      if (rendered.newline && pendingNewline) process.stdout.write("\n");
      process.stdout.write(rendered.newline ? `${rendered.text}\n` : rendered.text);
      pendingNewline = !rendered.newline;
    }

    const result = await run.result;
    if (pendingNewline) process.stdout.write("\n");
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ command: "run", ok: result.state.status === "completed", data: result })}\n`
      );
    } else {
      process.stdout.write(`\n${renderFooter(result.state, style)}\n`);
    }

    if (interrupted) return 130;
    return result.state.status === "completed" ? 0 : 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
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

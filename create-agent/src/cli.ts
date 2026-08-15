#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { generateAgentProject } from "./generator.js";

type Parsed = { directory?: string; name?: string; model?: string; yes: boolean };

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = { yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--yes") parsed.yes = true;
    else if (value === "--name") parsed.name = args[++index];
    else if (value === "--model") parsed.model = args[++index];
    else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else if (!parsed.directory) parsed.directory = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.yes && (!parsed.directory || !parsed.model)) throw new Error("--yes requires a directory and --model <creator/model>");
  const interactive = stdin.isTTY && stdout.isTTY;
  const prompt = interactive ? createInterface({ input: stdin, output: stdout }) : undefined;
  try {
    const directory = parsed.directory ?? await prompt?.question("Project directory: ");
    if (!directory) throw new Error("Directory and model are required in non-interactive mode");
    const defaultName = directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    const promptedName = parsed.name ?? (prompt ? await prompt.question(`Agent name (${defaultName}): `) : undefined);
    const model = parsed.model ?? await prompt?.question("Model (creator/model): ");
    if (!model) throw new Error("Directory and model are required in non-interactive mode");
    const result = await generateAgentProject({ directory, name: promptedName?.trim() || undefined, model });
    stdout.write(`Created ${result.name} in ${result.directory}\nPackage manager: ${result.packageManager} (${result.reason})\nNext: cd ${JSON.stringify(result.directory)} && ${result.packageManager} run build\n`);
  } finally {
    prompt?.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

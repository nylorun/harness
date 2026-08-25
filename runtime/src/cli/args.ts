/**
 * Argument parsing, kept apart from every command so it can be tested without a project, a build,
 * or a network. The parser is deliberately dumb: it recognises flags and collects positionals, and
 * every command decides for itself which of them mean anything.
 */

export const COMMANDS = [
  "check",
  "build",
  "serve",
  "runs",
  "publish",
  "adapter",
  "help",
  "version"
] as const;

export type Command = (typeof COMMANDS)[number];

export type Args = Readonly<{
  command: Command;
  /** Everything after the command that was not a flag — `runs show <id>` leaves `["show", "<id>"]`. */
  positionals: readonly string[];
  json: boolean;
  strict: boolean;
  yes: boolean;
  check: boolean;
  noPromote: boolean;
  project: string;
  port: number;
}>;

export type ParseFailure = Readonly<{ error: string; hint: string }>;

const FLAGS_WITH_VALUES = new Set(["--project", "--port"]);

export function parseArgs(argv: readonly string[], cwd = process.cwd()): Args | ParseFailure {
  let command: Command | undefined;
  const positionals: string[] = [];
  const flags = {
    json: false,
    strict: false,
    yes: false,
    check: false,
    noPromote: false,
    project: cwd,
    port: 4111,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--help" || arg === "-h") return finish("help", positionals, flags);
    if (arg === "--version" || arg === "-v") return finish("version", positionals, flags);

    if (FLAGS_WITH_VALUES.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: `${arg} needs a value.`, hint: `Write it as \`${arg} <value>\`.` };
      }
      index += 1;
      if (arg === "--project") flags.project = value;
      else if (arg === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { error: `--port ${value} is not a port number.`, hint: "Use an integer between 1 and 65535." };
        }
        flags.port = port;
      }
      continue;
    }

    if (arg === "--json") { flags.json = true; continue; }
    if (arg === "--strict") { flags.strict = true; continue; }
    if (arg === "--yes") { flags.yes = true; continue; }
    if (arg === "--check") { flags.check = true; continue; }
    if (arg === "--no-promote") { flags.noPromote = true; continue; }

    if (arg.startsWith("-") && arg !== "-") {
      return { error: `Unknown option ${arg}.`, hint: "Run `nylo --help` for the commands and their flags." };
    }

    if (command === undefined) {
      if (!(COMMANDS as readonly string[]).includes(arg)) {
        return { error: `Unknown command ${arg}.`, hint: `Known commands: ${COMMANDS.join(", ")}.` };
      }
      command = arg as Command;
      continue;
    }

    positionals.push(arg);
  }

  return finish(command ?? "help", positionals, flags);
}

function finish(
  command: Command,
  positionals: readonly string[],
  flags: Omit<Args, "command" | "positionals">
): Args {
  return Object.freeze({
    command,
    positionals: Object.freeze([...positionals]),
    ...flags
  }) as Args;
}

export function isFailure(value: Args | ParseFailure): value is ParseFailure {
  return "error" in value;
}

export const USAGE = `nylo — build, serve, inspect and ship a Nylo agent

  nylo check   [path]            type-check and structurally validate; imports nothing
  nylo build   [path]            run the project's build; --check verifies without writing
  nylo serve                     serve the built agent over HTTP, guarding nothing
  nylo runs    list|show|delete  read what past sessions did
  nylo publish                   upload the bundle, the manifest and the authoring archive
  nylo adapter probe             inspect the selected harness compatibility declaration

Common flags
  --json                   versioned envelope on stdout, for machines
  --project <dir>          act on a project other than the working directory
  --strict                 promote run-phase warnings to errors
  --yes                    proceed without the interactive execution disclosure

  serve    --port <n>      default 4111, bound to loopback
  publish  --no-promote    store the version without making it live

Exit codes: 0 ok · 1 the named phase failed · 2 usage or environment · 130 interrupted`;

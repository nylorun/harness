import type { CreateOptions } from "./contracts.js";

export const usage =
  "Usage: npm create @nylorun/agent@beta <directory> [--no-studio] [--no-open] [--skip-config] [--yes]";

export function parse(argv: readonly string[]): CreateOptions {
  const [directory, ...flags] = argv;
  if (!directory || directory.startsWith("-")) throw new Error(usage);
  if (
    flags.some(
      (flag) =>
        ![
          "--studio",
          "--no-studio",
          "--no-open",
          "--skip-config",
          "--yes",
        ].includes(flag),
    )
  )
    throw new Error(usage);
  return Object.freeze({
    directory,
    studio: !flags.includes("--no-studio"),
    open: !flags.includes("--no-open"),
    yes: flags.includes("--yes"),
    skipConfig: flags.includes("--skip-config"),
  });
}

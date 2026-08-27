import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type CredentialSource = "process-env" | "dotenv";

export type ResolvedCredential = Readonly<{
  variable: string;
  source: CredentialSource;
  value: string;
}>;

/**
 * A `.env` reader rather than a dependency. The format this needs is small, and a runtime
 * dependency on the public package is paid for by every consumer of it, including deployed agents.
 */
export function parseDotenv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).replace(/^export\s+/u, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/gu, "\n").replace(/\\"/gu, '"');
    } else {
      // An unquoted value ends at an inline comment; a quoted one may legitimately contain `#`.
      const comment = value.indexOf(" #");
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    values[key] = value;
  }
  return values;
}

export async function readDotenv(projectRoot: string): Promise<Record<string, string>> {
  try {
    return parseDotenv(await readFile(join(projectRoot, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Resolves the first of `variables` that has a value, reporting where it came from and never the
 * value's provenance beyond that. The OS keychain is a deliberate omission — reaching one costs
 * either a native dependency or platform-specific shelling, and the order here is written so
 * adding it later inserts a step rather than changing one.
 */
export async function resolveCredential(
  variables: readonly string[],
  options: Readonly<{ projectRoot: string; env?: Readonly<Record<string, string | undefined>> }>
): Promise<ResolvedCredential | undefined> {
  const env = options.env ?? process.env;
  for (const variable of variables) {
    const value = env[variable];
    if (value !== undefined && value !== "") return Object.freeze({ variable, source: "process-env", value });
  }

  const dotenv = await readDotenv(options.projectRoot);
  for (const variable of variables) {
    const value = dotenv[variable];
    if (value !== undefined && value !== "") return Object.freeze({ variable, source: "dotenv", value });
  }

  return undefined;
}

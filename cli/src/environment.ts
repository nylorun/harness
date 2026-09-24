import { readFileSync, statSync } from "node:fs";
import { writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";

/**
 * Read the Project `.env` into a value map. Does not mutate `process.env` (F3).
 */
export function loadProjectEnvironment(
  root = process.cwd(),
): Record<string, string> {
  const file = join(root, ".env");
  try {
    if (statSync(file).isDirectory())
      throw new Error(
        "The .env directory must be migrated manually: back it up, create a .env file with MODEL_PROVIDER, MODEL and MODEL_PROVIDER_API_KEY, and move OAuth credentials to .nylorun/auth.json. See the Runtime migration guide.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = parseEnv(readFileSync(file, "utf8"));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// Match complete dotenv assignments, including quoted multiline values.
const assignment =
  /^(?:export\s+)?([\w]+)[\t ]*=[\t ]*(?:"[^"]*"|'[^']*'|`[^`]*`|[^#\r\n]*)([^\r\n]*)(?:\r?\n|$)/gm;

export async function saveEnvironment(
  root: string,
  updates: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<void> {
  const file = join(root, ".env");
  let contents = "";
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const encode = (value: string) => {
    // Node's dotenv parser has no general quote-escaping syntax. Select a
    // delimiter absent from the value rather than changing the credential.
    for (const quote of ["'", '"', "`"]) {
      if (!value.includes(quote) && !(quote === '"' && /\\[nr]/.test(value)))
        return quote + value + quote;
    }
    throw new Error(
      "This value contains all dotenv quote delimiters; set it through your process environment instead.",
    );
  };
  const remaining = new Set(Object.keys(updates));
  contents = contents.replace(
    assignment,
    (whole, key: string, suffix: string) => {
      if (!(key in updates)) return whole;
      if (!remaining.delete(key)) return "";
      return updates[key] === undefined
        ? ""
        : `${key}=${encode(updates[key]!)}${suffix}\n`;
    },
  );
  if (contents && !contents.endsWith("\n")) contents += "\n";
  for (const key of remaining)
    if (updates[key] !== undefined)
      contents += `${key}=${encode(updates[key]!)}\n`;
  const temporary = join(root, `.env-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, signal });
    signal?.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

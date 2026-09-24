import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { LauncherError } from "./errors.js";

/**
 * Verify an npm-style SRI string (`sha512-<base64>`) against file bytes (D5).
 */
export async function verifyIntegrity(
  filePath: string,
  integrity: string,
): Promise<void> {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (!match) {
    throw new LauncherError(
      "integrity_mismatch",
      `Unsupported integrity value: ${integrity}`,
      "Use a registry that publishes sha512 SRI for Runtime builds.",
      { integrity },
    );
  }
  const expected = match[1]!;
  const hash = createHash("sha512");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  const actual = hash.digest("base64");
  if (actual !== expected) {
    throw new LauncherError(
      "integrity_mismatch",
      `Downloaded build failed integrity check.`,
      "Retry the install. If it keeps failing, clear the staging directory under runtime/ and check NYLORUN_REGISTRY.",
      { expected: `sha512-${expected}`, actual: `sha512-${actual}` },
    );
  }
}

export function integrityOfBuffer(buffer: Buffer): string {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

export async function integrityOfFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return integrityOfBuffer(buffer);
}

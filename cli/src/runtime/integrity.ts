import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { CliError } from "../errors.js";

/** Verify an npm-style SRI string (`sha512-<base64>`) against file bytes (D5). */
export async function verifyIntegrity(
  filePath: string,
  integrity: string,
): Promise<void> {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (!match) {
    throw new CliError(
      `Unsupported integrity value: ${integrity}`,
      1,
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
    throw new CliError(
      "Downloaded Runtime build failed integrity check.",
      1,
    );
  }
}

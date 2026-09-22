import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseKek } from "./crypto.js";

export function defaultKekPath(): string {
  return join(process.cwd(), ".nylorun", "vault-kek");
}

export function readVaultKek(options: {
  vaultKek?: Buffer | string | null;
  vaultKekPath?: string;
}): Buffer | undefined {
  if (options.vaultKek === null) return undefined;
  if (options.vaultKek !== undefined) return parseKek(options.vaultKek);
  const fromEnv = process.env.NYLORUN_VAULT_KEK;
  if (fromEnv) return parseKek(fromEnv);
  const path = options.vaultKekPath ?? defaultKekPath();
  if (!existsSync(path)) return undefined;
  return parseKek(readFileSync(path, "utf8"));
}

export function createKekFile(path: string): Buffer {
  const bytes = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${bytes.toString("base64")}\n`, { mode: 0o600 });
  return bytes;
}

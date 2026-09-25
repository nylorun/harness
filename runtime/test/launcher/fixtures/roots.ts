import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function temporaryRoot(
  prefix = "nylorun-launcher-",
): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

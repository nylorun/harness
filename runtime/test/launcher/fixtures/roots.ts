import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function temporaryRoot(
  prefix = "nylorun-launcher-",
): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeRoot(root: string): Promise<void> {
  // Windows Host/node.exe can briefly lock files under the home after down().
  try {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (
      process.platform === "win32" &&
      (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")
    ) {
      return;
    }
    throw error;
  }
}

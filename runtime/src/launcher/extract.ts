import { spawn } from "node:child_process";
import { LauncherError } from "./errors.js";

/**
 * Extract a gzip npm tarball into `dest`, stripping the leading `package/` (D4).
 */
export async function extractTarball(
  tarballPath: string,
  dest: string,
): Promise<void> {
  await preflightTar();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-xzf", tarballPath, "-C", dest, "--strip-components=1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      reject(
        new LauncherError(
          "install_failed",
          `Failed to run tar: ${error.message}`,
          "Install a system tar (macOS, Linux, and Windows 10 1803+ ship one) and retry.",
        ),
      );
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new LauncherError(
            "install_failed",
            `tar extraction failed (${code}).${stderr ? `\n${stderr.trim()}` : ""}`,
            "Retry the install. If it keeps failing, check the downloaded tarball and free disk space.",
          ),
        );
    });
  });
}

async function preflightTar(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("error", () => {
      reject(
        new LauncherError(
          "install_failed",
          "System tar is not available on PATH.",
          "Install a system tar (macOS, Linux, and Windows 10 1803+ ship one) and retry.",
        ),
      );
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new LauncherError(
            "install_failed",
            "System tar did not respond to --version.",
            "Install a working system tar and retry.",
          ),
        );
    });
  });
}

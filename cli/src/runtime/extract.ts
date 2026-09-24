import { spawn } from "node:child_process";
import { CliError } from "../errors.js";

/** Extract a gzip npm tarball into `dest`, stripping the leading `package/` (D4). */
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
        new CliError(
          `Failed to run tar: ${error.message}`,
          1,
        ),
      );
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new CliError(
            `tar extraction failed (${code}).${stderr ? `\n${stderr.trim()}` : ""}`,
            1,
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
        new CliError(
          "System tar is not available on PATH.",
          1,
        ),
      );
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new CliError("System tar did not respond to --version.", 1),
        );
    });
  });
}

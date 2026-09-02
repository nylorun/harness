import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seed = 'export function hello(name = "world") {\n  return `hello ${name}`;\n}\n';

/** Host-owned Codex CLI runner. Workspaces are temporary and never this repository. */
export class CodexWorkspace {
  readonly root: Promise<string>;

  constructor() {
    this.root = mkdtemp(join(tmpdir(), "nylorun-codex-workspace-")).then(async (root) => {
      await writeFile(join(root, "hello.js"), seed, "utf8");
      return root;
    });
  }

  async exec(
    task: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
    const root = await this.root;
    return run(
      "codex",
      [
        "exec",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--ephemeral",
        "-C",
        root,
        task,
      ],
      180_000,
      signal,
    );
  }
}

export async function codexAvailable(): Promise<boolean> {
  try {
    const result = await run("codex", ["--version"], 5_000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function run(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => stdout.push(data));
    child.stderr.on("data", (data: Buffer) => stderr.push(data));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolveRun({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 65_536),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 65_536),
      });
    });
  });
}

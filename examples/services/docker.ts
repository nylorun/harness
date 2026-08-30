import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export class DockerWorkspace {
  readonly root: Promise<string>;

  constructor() {
    this.root = mkdtemp(join(tmpdir(), "nylorun-studio-workspace-")).then(async (root) => {
      await chmod(root, 0o777);
      return root;
    });
  }

  async write(path: string, content: string): Promise<void> {
    const file = await this.path(path);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, content, "utf8");
  }

  async read(path: string): Promise<string> {
    return readFile(await this.path(path), "utf8");
  }

  async list(): Promise<readonly string[]> {
    const root = await this.root;
    return run(
      "docker",
      dockerArgs(root, ["sh", "-lc", "find . -maxdepth 3 -type f | sort"]),
      20_000,
    ).then((result) => result.stdout.split("\n").filter(Boolean));
  }

  async shell(
    script: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
    const root = await this.root;
    return run("docker", dockerArgs(root, ["sh", "-lc", script]), 30_000, signal);
  }

  private async path(path: string): Promise<string> {
    if (!path || path.startsWith("/") || path.split("/").includes(".."))
      throw new Error("Use a safe relative workspace path.");
    return join(await this.root, path);
  }
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    const result = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 5_000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function dockerArgs(workspace: string, command: readonly string[]): string[] {
  return [
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    "64",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=bind,src=${workspace},dst=/workspace`,
    "--workdir",
    "/workspace",
    "--user",
    "65534:65534",
    "node:22-alpine",
    ...command,
  ];
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

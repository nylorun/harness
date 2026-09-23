/** microsandbox backend: a hardware-isolated microVM per sandbox (libkrun). */
import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SANDBOX_WORKSPACE } from "@nylorun/core/define";
import type {
  ExecRequest,
  ExecResult,
  SandboxBackend,
  SandboxHandle,
  SandboxProbe,
  SandboxSpec,
} from "../../sandbox/types.js";

type Microsandbox = typeof import("microsandbox");

/** Releases that are known not to work; the probe refuses them and selection falls back. */
const KNOWN_BAD_VERSIONS = new Set(["0.7.0"]);
/** Keep at most this much of each output stream in memory while a command runs. */
const CAPTURE_LIMIT = 4 * 1024 * 1024;

const require = createRequire(import.meta.url);

/** The package's exports map hides package.json, so walk up from its entry point. */
function installedVersion(): string | undefined {
  try {
    let directory = dirname(require.resolve("microsandbox"));
    for (let depth = 0; depth < 4; depth += 1, directory = dirname(directory)) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (manifest.name === "microsandbox") return manifest.version;
      } catch {}
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function platformReason(): string | undefined {
  if (process.platform === "darwin")
    return process.arch === "arm64" ? undefined : "requires Apple Silicon on macOS";
  if (process.platform === "linux") {
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
      return undefined;
    } catch {
      return "no usable /dev/kvm (enable KVM or nested virtualisation)";
    }
  }
  if (process.platform === "win32") return "not yet enabled on Windows";
  return `unsupported platform ${process.platform}`;
}

export function microsandboxBackend(): SandboxBackend {
  let sdk: Promise<Microsandbox> | undefined;
  const load = () => (sdk ??= import("microsandbox"));

  const handleFor = (sandbox: InstanceType<Microsandbox["Sandbox"]>): SandboxHandle => ({
    async exec(request: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
      const execution = await sandbox.execStreamWith("bash", (options) =>
        options
          .args(["-c", request.command])
          .cwd(request.cwd)
          .envs({ LANG: "C.UTF-8", TERM: "dumb" })
          .stdinNull()
      );
      const stdout = new Capture();
      const stderr = new Capture();
      let killed = false;
      let timedOut = false;
      const kill = () => {
        if (killed) return;
        killed = true;
        void execution.kill().catch(() => undefined);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);
      const onAbort = () => kill();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) kill();
      let exitCode = -1;
      try {
        for await (const event of execution) {
          if (event.kind === "stdout") stdout.push(event.data);
          else if (event.kind === "stderr") stderr.push(event.data);
          else if (event.kind === "exited") {
            exitCode = event.code;
            break;
          }
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
      return {
        exitCode: killed && exitCode < 0 ? (timedOut ? 124 : 130) : exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        killed,
        timedOut,
      };
    },
    async readFile(path) {
      const fs = sandbox.fs();
      if (!(await fs.exists(path))) return undefined;
      return fs.readToString(path);
    },
    async writeFile(path, content) {
      await sandbox.fs().write(path, content);
    },
    async stop() {
      await sandbox.stop();
    },
  });

  return {
    name: "microsandbox",
    isolation: "vm",
    async probe(): Promise<SandboxProbe> {
      const base = { name: "microsandbox" as const, isolation: "vm" as const };
      const version = installedVersion();
      const platform = platformReason();
      if (platform) return { ...base, available: false, reason: platform, ...(version ? { version } : {}) };
      if (!version)
        return {
          ...base,
          available: false,
          reason: "the optional microsandbox package is not installed (reinstall with optional dependencies enabled)",
        };
      if (KNOWN_BAD_VERSIONS.has(version))
        return { ...base, available: false, version, reason: `microsandbox ${version} is a known-bad release` };
      try {
        const msb = await load();
        if (!(await msb.isRuntimeInstalled()))
          return { ...base, available: false, version, reason: "the microsandbox runtime (msb, libkrunfw) is not installed" };
      } catch (error) {
        return {
          ...base,
          available: false,
          version,
          reason: `could not load microsandbox: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { ...base, available: true, version, reason: "hardware-isolated microVM" };
    },
    unmet() {
      return undefined;
    },
    async open(spec: SandboxSpec): Promise<SandboxHandle> {
      const msb = await load();
      const { Sandbox, SandboxNotFoundError } = msb;
      try {
        const existing = await Sandbox.get(spec.key);
        return handleFor(await existing.connectOrStart());
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
      const sandbox = await Sandbox.builder(spec.key)
        .image(spec.image)
        .cpus(spec.cpus)
        .memory(spec.memoryMiB)
        .patch((patch) => patch.mkdir(SANDBOX_WORKSPACE, { mode: 0o755 }))
        .workdir(SANDBOX_WORKSPACE)
        .label("nylorun", "sandbox")
        .network((network) => network.policy(policyFor(msb, spec)))
        .create();
      return handleFor(sandbox);
    },
    async remove(key: string) {
      const { Sandbox, SandboxNotFoundError } = await load();
      try {
        const handle = await Sandbox.get(key);
        await handle.destroy({ force: true });
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
    },
    async list(prefix: string) {
      const { Sandbox } = await load();
      const keys: string[] = [];
      let page = await Sandbox.list();
      for (;;) {
        for (const handle of page.sandboxes)
          if (handle.name.startsWith(prefix)) keys.push(handle.name);
        if (!page.nextCursor) break;
        const cursor = page.nextCursor;
        page = await Sandbox.listWith((list) => list.cursor(cursor));
      }
      return keys;
    },
  };
}

/** Deny by default. Private, loopback, link-local, metadata and host ranges are always denied. */
function policyFor(msb: Microsandbox, spec: SandboxSpec) {
  const { Destination, Rule } = msb;
  const always = ["private", "loopback", "link-local", "metadata", "multicast"] as const;
  // The host is denied for TCP only: its resolver answers DNS for the sandbox and filters
  // names by this same policy, so a UDP deny would break every allowed host.
  const host = {
    direction: "egress" as const,
    destination: Destination.group("host"),
    protocols: ["tcp" as const],
    ports: [],
    action: "deny" as const,
  };
  return {
    defaultEgress: "deny" as const,
    defaultIngress: "deny" as const,
    rules: [
      ...always.map((group) => Rule.denyEgress(Destination.group(group))),
      host,
      ...(spec.network.preset === "open" ? [Rule.allowEgress(Destination.group("public"))] : []),
      ...spec.network.hosts.map((host) => Rule.allowEgress(Destination.domain(host))),
      ...spec.network.suffixes.map((suffix) => Rule.allowEgress(Destination.domainSuffix(suffix))),
    ],
  };
}

class Capture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private dropped = 0;
  push(data: Uint8Array | string) {
    const chunk = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    if (this.size >= CAPTURE_LIMIT) {
      this.dropped += chunk.length;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }
  text(): string {
    const text = Buffer.concat(this.chunks).toString("utf8");
    return this.dropped > 0 ? `${text}\n… [${this.dropped} bytes not captured]` : text;
  }
}

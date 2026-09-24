import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/core/compatibility";
import { startEphemeralRuntime } from "@nylorun/runtime";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
const runtimes: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function run(
  answer: (text: string, child: ReturnType<typeof spawn>) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "configure-cli-"));
  roots.push(root);
  const hostRoot = await mkdtemp(join(tmpdir(), "configure-host-"));
  roots.push(hostRoot);
  const runtime = await startEphemeralRuntime({
    hostRoot,
    baseline: { PATH: process.env.PATH ?? "/usr/bin" },
    model: { kind: "fixture" },
  });
  const port = new URL(runtime.url).port;
  runtimes.push(runtime);
  // Configuration must work even before the application's agent graph can load.
  await writeFile(join(root, "nylorun.config.ts"), "invalid typescript !");
  const child = spawn(process.execPath, [cli, "configure"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: port,
      NYLORUN_SERVER_KEY: runtime.applicationKey,
      NYLORUN_TENANT: runtime.tenantId,
      MODEL_PROVIDER_API_KEY: "",
    },
  });
  let text = "";
  child.stdout!.on("data", (data) => {
    text += data;
    answer(text, child);
  });
  child.stderr!.on("data", (data) => {
    text += data;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return {
      root,
      code,
      text,
      runtimeUrl: runtime.url,
      serverKey: runtime.applicationKey,
      tenantId: runtime.tenantId,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tenantHeaders(key: string, tenantId: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
}

// TENANTS-W2: interactive provider catalog + Tenant vault seed lands with WS-F.
it.todo("configures a custom provider using scripted stdin and no live model calls");

it.each(["SIGINT", "SIGTERM", "EOF"] as const)(
  "exits promptly on %s while prompting",
  async (signal) => {
    let sent = false;
    const result = await run((text, child) => {
      if (!sent && text.includes("Choose a provider:")) {
        sent = true;
        if (signal === "EOF") child.stdin!.end();
        else child.kill(signal);
      }
    });
    expect(result.code, result.text).toBe(
      signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1,
    );
    expect(result.text).not.toContain("Provider configuration saved.");
  },
);

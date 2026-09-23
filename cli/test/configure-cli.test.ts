import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { startRuntime } from "@nylorun/runtime/core";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
const runtimes: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function run(
  answer: (text: string, child: ReturnType<typeof spawn>) => void
) {
  const root = await mkdtemp(join(tmpdir(), "configure-cli-"));
  roots.push(root);
  const serverKey = "server-token-value-16";
  const runtime = await startRuntime({
    sqlitePath: join(root, "runtime.sqlite"),
    serverToken: serverKey,
    executors: [],
    vaultKek: Buffer.alloc(32, 7).toString("base64"),
    port: 0,
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
      NYLORUN_SERVER_KEY: serverKey,
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
    return { root, code, text, runtimeUrl: runtime.url, serverKey };
  } finally {
    clearTimeout(timer);
  }
}

it("configures a custom provider using scripted stdin and no live model calls", async () => {
  const questions = [
    ["Choose a provider:", "0"],
    ["OpenAI-compatible base URL:", "http://127.0.0.1:1/v1"],
    ["Model id:", "fixture"],
    ["Custom API key", "fixture-key"],
  ];
  let index = 0;
  const result = await run((text, child) => {
    const question = questions[index];
    if (question && text.includes(question[0])) {
      index++;
      child.stdin!.write(question[1] + "\n");
    }
  });
  expect(result.code, result.text).toBe(0);
  const stored = await fetch(`${result.runtimeUrl}/v1/host/model`, {
    headers: { authorization: `Bearer ${result.serverKey}` },
  });
  const body = await stored.json();
  expect(body).toMatchObject({
    configured: true,
    provider: "custom",
    model: "fixture",
    authType: "api_key",
  });
  expect(JSON.stringify(body)).not.toContain("fixture-key");
  await expect(readFile(join(result.root, ".env"), "utf8")).rejects.toThrow();
});

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
      signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1
    );
    expect(result.text).not.toContain("Provider configuration saved.");
  }
);

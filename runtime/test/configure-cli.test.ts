import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function run(
  answer: (text: string, child: ReturnType<typeof spawn>) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "configure-cli-"));
  roots.push(root);
  // Configuration must work even before the application's agent graph can load.
  await writeFile(join(root, "nylorun.config.ts"), "invalid typescript !");
  const child = spawn(process.execPath, [cli, "configure"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NYLO_CUSTOM_API_KEY: "" },
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
    return { root, code, text };
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
  expect(
    JSON.parse(await readFile(join(result.root, "config/model.json"), "utf8"))
      .model,
  ).toBe("fixture");
  expect(
    JSON.parse(await readFile(join(result.root, ".env/auth.json"), "utf8"))
      .custom.key,
  ).toBe("fixture-key");
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
      signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1,
    );
    expect(result.text).not.toContain("Provider configuration saved.");
  },
);

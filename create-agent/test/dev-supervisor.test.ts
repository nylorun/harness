import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const canListen = await permitsListening();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it.skipIf(process.platform === "win32" || !canListen)(
  "waits for the application, forwards --no-open, and stops both children",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-dev-supervisor-"));
    roots.push(root);
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await cp(
      join(process.cwd(), "starter/scripts/dev.mjs"),
      join(root, "dev.mjs")
    );
    await writeBin(
      root,
      "tsx",
      `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const server = createServer((_request, response) => response.end("ok"));
server.listen(Number(process.env.PORT));
process.on("SIGTERM", () => { writeFileSync("app-stopped", "yes"); server.close(() => process.exit(0)); });
`
    );
    await writeBin(
      root,
      "nylorun",
      `
import { writeFileSync } from "node:fs";
writeFileSync("studio-args.json", JSON.stringify(process.argv.slice(2)));
process.on("SIGTERM", () => { writeFileSync("studio-stopped", "yes"); process.exit(0); });
setInterval(() => {}, 1_000);
`
    );
    const port = 35_000 + Math.floor(Math.random() * 10_000);
    const supervisor = spawn(process.execPath, ["dev.mjs", "--no-open"], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    });
    try {
      await waitFor(async () => {
        const args = JSON.parse(
          await readFile(join(root, "studio-args.json"), "utf8")
        );
        expect(args).toEqual([
          "studio",
          "--agent-url",
          `http://localhost:${port}/agents`,
          "--no-open",
        ]);
      });
      supervisor.kill("SIGTERM");
      await waitFor(async () => {
        expect(await readFile(join(root, "app-stopped"), "utf8")).toBe("yes");
        expect(await readFile(join(root, "studio-stopped"), "utf8")).toBe(
          "yes"
        );
      });
    } finally {
      supervisor.kill("SIGKILL");
    }
  },
  10_000
);

async function writeBin(root: string, name: string, body: string) {
  const path = join(root, "node_modules/.bin", name);
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(path, `#!/usr/bin/env node\n${body}`);
  await chmod(path, 0o755);
}

async function waitFor(check: () => Promise<void>) {
  const deadline = Date.now() + 5_000;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (cause) {
      error = cause;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw error;
}

async function permitsListening() {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return true;
  } catch {
    server.close();
    return false;
  }
}

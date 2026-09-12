import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
const processes: ChildProcess[] = [];
afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture(app = true, studio = true) {
  const root = await mkdtemp(join(tmpdir(), "nylorun-dev-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  if (app) {
    await mkdir(join(root, "node_modules/tsx"), { recursive: true });
    await writeFile(
      join(root, "node_modules/tsx/package.json"),
      '{"type":"module","exports":{"./cli":"./cli.js"}}'
    );
    await writeFile(
      join(root, "node_modules/tsx/cli.js"),
      `
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
writeFileSync('app.json', JSON.stringify({args:process.argv.slice(2),dev:process.env.NYLORUN_DEV}));
const server=createServer((req,res)=>{res.end('ok');});
server.listen(Number(process.env.PORT));
process.on('SIGTERM',()=>{writeFileSync('app-stopped','yes');server.close(()=>process.exit(0));});
process.on('SIGINT',()=>{server.close(()=>process.exit(0));});
`
    );
  }
  if (studio) {
    await mkdir(join(root, "node_modules/@nylorun/studio"), {
      recursive: true,
    });
    await writeFile(
      join(root, "node_modules/@nylorun/studio/package.json"),
      '{"type":"module","exports":"./index.js"}'
    );
    await writeFile(
      join(root, "node_modules/@nylorun/studio/index.js"),
      `
import {writeFileSync} from 'node:fs';
export async function startStudio(options) {
  writeFileSync('studio.json',JSON.stringify(options));
  const timer=setInterval(()=>{},1000);
  return {address:'http://localhost:4161',close:async()=>{clearInterval(timer);writeFileSync('studio-stopped','yes');}};
}`
    );
  }
  return root;
}
async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function run(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [cli, "dev", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code))
  );
  return { child, closed, output: () => output };
}
async function wait(check: () => Promise<void>) {
  const deadline = Date.now() + 5_000;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (failure) {
      error = failure;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw error;
}
it("runs local tsx with development enabled, waits for readiness, and closes both children", async () => {
  const root = await fixture();
  const appPort = await port();
  const task = run(root, ["--no-open"], { PORT: String(appPort) });
  await wait(async () => {
    expect(
      JSON.parse(await readFile(join(root, "studio.json"), "utf8"))
    ).toEqual({
      agentServerUrl: `http://localhost:${appPort}/agents`,
      open: false,
    });
    expect(JSON.parse(await readFile(join(root, "app.json"), "utf8"))).toEqual({
      args: ["watch", "src/index.ts"],
      dev: "1",
    });
  });
  task.child.kill("SIGTERM");
  expect(await task.closed).toBe(143);
  // Children may finish writing stop markers slightly after the supervisor exits.
  await wait(async () => {
    expect(await readFile(join(root, "app-stopped"), "utf8")).toBe("yes");
    expect(await readFile(join(root, "studio-stopped"), "utf8")).toBe("yes");
  });
});
it("runs without a Studio dependency and accepts both flags", async () => {
  const root = await fixture(true, false);
  const task = run(root, ["--no-studio", "--no-open"], {
    PORT: String(await port()),
  });
  await wait(async () => {
    expect(JSON.parse(await readFile(join(root, "app.json"), "utf8")).dev).toBe(
      "1"
    );
  });
  task.child.kill("SIGINT");
  expect(await task.closed).toBe(130);
  await expect(readFile(join(root, "studio.json"))).rejects.toThrow();
});
it.each([
  [false, false, [], {}, "Install tsx"],
  [true, false, [], {}, "Install @nylorun/studio"],
  [true, true, ["--bad"], {}, "Usage:"],
  [true, true, ["--no-open", "--no-open"], {}, "Usage:"],
  [true, true, [], { PORT: "0" }, "PORT must"],
] as const)(
  "rejects invalid setup before starting children (%s, %s, %s)",
  async (app, studio, args, env, message) => {
    const root = await fixture(app, studio);
    const task = run(root, [...args], env);
    expect(await task.closed).toBe(1);
    expect(task.output()).toContain(message);
    await expect(readFile(join(root, "app.json"))).rejects.toThrow();
  }
);
it("propagates an application failure without waiting for readiness timeout", async () => {
  const root = await fixture();
  await writeFile(join(root, "node_modules/tsx/cli.js"), "process.exit(7)");
  const task = run(root, [], { PORT: String(await port()) });
  expect(await task.closed).toBe(7);
  await expect(readFile(join(root, "studio.json"))).rejects.toThrow();
});
it("stops the application when Studio fails", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "node_modules/@nylorun/studio/index.js"),
    "export async function startStudio(){throw new Error('fixture Studio failure')}"
  );
  const task = run(root, [], { PORT: String(await port()) });
  expect(await task.closed).toBe(1);
  expect(task.output()).toContain("fixture Studio failure");
  await wait(async () => {
    expect(await readFile(join(root, "app-stopped"), "utf8")).toBe("yes");
  });
});
it("times out an unready application and shuts it down", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "node_modules/tsx/cli.js"),
    "setInterval(()=>{},1000)"
  );
  const task = run(root, [], { PORT: String(await port()) });
  expect(await task.closed).toBe(1);
  expect(task.output()).toContain("within 20 seconds");
}, 25_000);

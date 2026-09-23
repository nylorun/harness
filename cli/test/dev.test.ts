import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createSocket } from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
const processes: ChildProcess[] = [];
let home = "";
// The Runtime now outlives the CLI, so every test needs its own home and must kill the
// daemon before the temp tree is removed or SQLite races the deletion.
async function reap(root: string) {
  for (const directory of [join(root, ".nylorun"), home]) {
    const pid = Number(
      await readFile(join(directory, "runtime.pid"), "utf8").catch(() => "")
    );
    if (Number.isSafeInteger(pid) && pid > 0)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
  }
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nylorun-home-"));
});
afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  for (const root of roots) await reap(root);
  await reap(home);
  await Promise.all(
    [...roots.splice(0), home].map((root) =>
      rm(root, { recursive: true, force: true })
    )
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
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
writeFileSync('app.json', JSON.stringify({args:process.argv.slice(2)}));
process.on('SIGTERM',()=>writeFileSync('app-stopped','yes'));
try { await import(pathToFileURL(process.argv[4]).href); }
catch(error) { console.error(error.message); process.exitCode=1; }
finally { writeFileSync('app-stopped','yes'); }

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
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, "agents/index.ts"),
    `import { Agent } from ${JSON.stringify(
      new URL("../../core/dist/define.js", import.meta.url).href
    )}; export const agents=[Agent({id:"test",name:"Test"}).build()];`
  );
  return root;
}
async function port() {
  const server = createSocket();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function run(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  command = "dev"
) {
  const child = spawn(process.execPath, [cli, command, ...args], {
    cwd: root,
    env: {
      ...process.env,
      NYLORUN_DEV_MODEL: "fixture",
      NYLORUN_HOME: home,
      ...env,
    },
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
it(
  "runs local tsx with development enabled, waits for readiness, and closes both children",
  { timeout: 15_000 },
  async () => {
    const root = await fixture();
    const appPort = await port();
    const task = run(root, ["--no-open"], { PORT: String(appPort) });
    await wait(async () => {
      expect(
        JSON.parse(await readFile(join(root, "studio.json"), "utf8"))
      ).toEqual({
        runtimeUrl: `http://127.0.0.1:${appPort}`,
        serverKey: expect.any(String),
        open: false,
      });
      expect(
        JSON.parse(await readFile(join(root, "app.json"), "utf8"))
      ).toEqual({
        args: [
          "watch",
          "--clear-screen=false",
          fileURLToPath(new URL("../dist/dev-entry.js", import.meta.url)),
          "--no-open",
        ],
      });
    });
    task.child.kill("SIGTERM");
    expect(await task.closed).toBe(0);
    expect(await readFile(join(root, "app-stopped"), "utf8")).toBe("yes");
    expect(await readFile(join(root, "studio-stopped"), "utf8")).toBe("yes");
  }
);
it(
  "runs without a Studio dependency and accepts both flags",
  { timeout: 15_000 },
  async () => {
    const root = await fixture(true, false);
    const task = run(root, ["--no-studio", "--no-open"], {
      PORT: String(await port()),
    });
    await wait(async () => {
      expect(
        JSON.parse(await readFile(join(root, "app.json"), "utf8")).args
      ).toContain("--no-studio");
      expect(task.output()).toContain("Local project ready");
    });
    task.child.kill("SIGINT");
    expect(await task.closed).toBe(0);
    await expect(readFile(join(root, "studio.json"))).rejects.toThrow();
  }
);
it.each([
  [false, false, [], {}, "Install tsx", 1],
  [true, false, [], {}, "Install @nylorun/studio", 1],
  [true, true, ["--bad"], {}, "nylorun <runtime", 2],
  [true, true, ["--no-open", "--no-open"], {}, "only be supplied once", 2],
  [true, true, [], { PORT: "0" }, "between 1 and 65535", 1],
] as const)(
  "rejects invalid setup before starting children (%s, %s, %s)",
  async (app, studio, args, env, message, code) => {
    const root = await fixture(app, studio);
    const task = run(root, [...args], { PORT: String(await port()), ...env });
    expect(await task.closed).toBe(code);
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
  expect(await readFile(join(root, "app-stopped"), "utf8")).toBe("yes");
});
it("refuses an occupied Runtime port without disturbing its owner", { timeout: 15_000 }, async () => {
  const root = await fixture();
  const sockets: import("node:net").Socket[] = [];
  const occupied = createSocket((socket) => sockets.push(socket));
  await new Promise<void>((resolve) =>
    occupied.listen(0, "127.0.0.1", resolve)
  );
  try {
    const address = occupied.address() as { port: number };
    const task = run(root, [], { PORT: String(address.port) });
    expect(await task.closed).toBe(4);
    expect(task.output()).toContain("is in use by another process");
    await expect(readFile(join(root, "studio.json"))).rejects.toThrow();
  } finally {
    // The probe leaves an accepted socket behind; drop it so close() can settle.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

it.each([undefined, "custom.js"])(
  "starts an exported registry with .env loaded before import (%s)",
  { timeout: 20_000 },
  async (entry) => {
    const root = await fixture(false, false);
    const appPort = await port();
    await mkdir(join(root, "dist/agents"), { recursive: true });
    await writeFile(
      join(root, entry ?? "dist/agents/index.js"),
      `
import { Agent } from ${JSON.stringify(
        new URL("../../core/dist/define.js", import.meta.url).href
      )};
export const agents = [Agent({id:"test",name:process.env.MODEL}).build()];
`
    );
    await writeFile(
      join(root, ".env"),
      `PORT=${appPort}\nMODEL=dotenv-model\nNYLORUN_DEV=1\n`
    );
    const task = run(
      root,
      entry ? [entry] : [],
      { PORT: String(appPort), MODEL: "host-model" },
      "serve"
    );
    await wait(async () => {
      expect(task.output()).toContain("Local project ready");
      const { serverKey } = JSON.parse(
        await readFile(join(root, ".nylorun/local-credentials.json"), "utf8")
      );
      const discovery = await (
        await fetch(`http://127.0.0.1:${appPort}/v1/agents`, {
          headers: { authorization: `Bearer ${serverKey}` },
        })
      ).json();
      expect(discovery.agents[0].manifest.name).toBe("host-model");
    });
    task.child.kill("SIGTERM");
    expect(await task.closed).toBe(0);
  }
);

it("reports an invalid application export without opening a socket", async () => {
  const root = await fixture(false, false);
  await writeFile(join(root, "invalid.js"), "export default {};");
  const task = run(root, ["invalid.js"], { PORT: String(await port()) }, "serve");
  expect(await task.closed).toBe(1);
  expect(task.output()).toContain("must export a non-empty agents array");
});

it(
  "starts the Runtime itself and leaves it running after the CLI exits",
  { timeout: 20_000 },
  async () => {
    const root = await fixture();
    const appPort = await port();
    const task = run(root, ["--no-open"], { PORT: String(appPort) });
    await wait(async () => {
      expect(task.output()).toContain("Started the Runtime for project");
      expect(task.output()).toContain("Local project ready");
    });
    const url = `http://127.0.0.1:${appPort}`;
    task.child.kill("SIGTERM");
    expect(await task.closed).toBe(0);
    // The host is a separate process now; stopping dev must not take it down.
    expect((await (await fetch(`${url}/health`)).json()).service).toBe(
      "oss-runtime"
    );
    const first = Number(
      await readFile(join(root, ".nylorun/runtime.pid"), "utf8")
    );

    const again = run(root, ["--no-open"], { PORT: String(appPort) });
    await wait(async () =>
      expect(again.output()).toContain("Local project ready")
    );
    expect(again.output()).not.toContain("Started the Runtime");
    expect(
      Number(await readFile(join(root, ".nylorun/runtime.pid"), "utf8"))
    ).toBe(first);
    again.child.kill("SIGTERM");
    expect(await again.closed).toBe(0);

    const stop = run(root, [], { PORT: String(appPort) }, "down");
    expect(await stop.closed).toBe(0);
    expect(stop.output()).toContain("Stopped the Runtime");
    await expect(fetch(`${url}/health`)).rejects.toThrow();
    // Stopping keeps the database and credentials.
    await readFile(join(root, ".nylorun/runtime.sqlite"));
    await readFile(join(root, ".nylorun/local-credentials.json"));
  }
);

it(
  "refuses to autostart when told not to, and succeeds once a Runtime is up",
  { timeout: 20_000 },
  async () => {
    const root = await fixture();
    const appPort = await port();
    const refused = run(root, ["--no-open", "--no-autostart"], {
      PORT: String(appPort),
    });
    expect(await refused.closed).toBe(6);
    expect(refused.output()).toContain("No Runtime is listening");
    await expect(
      readFile(join(root, ".nylorun/runtime.pid"))
    ).rejects.toThrow();

    const up = run(root, [], { PORT: String(appPort) }, "up");
    expect(await up.closed).toBe(0);
    expect(up.output()).toContain("npx nylorun dev");
    const task = run(root, ["--no-open", "--no-autostart"], {
      PORT: String(appPort),
    });
    await wait(async () =>
      expect(task.output()).toContain("Local project ready")
    );
    task.child.kill("SIGTERM");
    expect(await task.closed).toBe(0);
  }
);

it(
  "recovers a stale pid file after the Runtime is killed outright",
  { timeout: 20_000 },
  async () => {
    const root = await fixture(false, false);
    const appPort = await port();
    const first = run(root, [], { PORT: String(appPort) }, "up");
    expect(await first.closed).toBe(0);
    const pid = Number(
      await readFile(join(root, ".nylorun/runtime.pid"), "utf8")
    );
    process.kill(pid, "SIGKILL");
    await wait(async () => {
      try {
        process.kill(pid, 0);
        throw new Error("still running");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    });
    // The Runtime's own SQLite lock survives a SIGKILL and is reclaimed on the next boot.
    await readFile(join(root, ".nylorun/runtime.sqlite.runtime-lock"));

    const second = run(root, [], { PORT: String(appPort) }, "up");
    expect(await second.closed).toBe(0);
    expect(
      Number(await readFile(join(root, ".nylorun/runtime.pid"), "utf8"))
    ).not.toBe(pid);
  }
);

it(
  "reports status as text and JSON, and exits 3 when nothing is running",
  { timeout: 20_000 },
  async () => {
    const root = await fixture(false, false);
    const appPort = await port();
    const missing = run(root, ["status"], { PORT: String(appPort) }, "runtime");
    expect(await missing.closed).toBe(3);

    const logs = run(root, ["logs"], { PORT: String(appPort) }, "runtime");
    expect(await logs.closed).toBe(3);
    expect(logs.output()).toContain("No Runtime log");

    expect(await run(root, [], { PORT: String(appPort) }, "up").closed).toBe(0);
    const text = run(root, ["status"], { PORT: String(appPort) }, "runtime");
    expect(await text.closed).toBe(0);
    expect(text.output()).toContain("State");
    expect(text.output()).toContain("running");

    const json = run(
      root,
      ["status", "--output", "json"],
      { PORT: String(appPort) },
      "runtime"
    );
    expect(await json.closed).toBe(0);
    expect(JSON.parse(json.output())).toMatchObject({
      scope: "project",
      root: await realpath(root),
      url: `http://127.0.0.1:${appPort}`,
      state: "running",
      pid: expect.any(Number),
      scopeId: expect.any(String),
    });

    const tail = run(root, ["logs"], { PORT: String(appPort) }, "runtime");
    expect(await tail.closed).toBe(0);
  }
);

it(
  "fails a dev run against a Runtime that does not match this CLI",
  { timeout: 20_000 },
  async () => {
    const root = await fixture();
    const appPort = await port();
    const stub = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          service: "oss-runtime",
          version: "0.0.0-old",
          scopeId: "0123456789abcdef",
        })
      );
    });
    await new Promise<void>((resolve) =>
      stub.listen(appPort, "127.0.0.1", resolve)
    );
    try {
      const task = run(root, ["--no-open"], { PORT: String(appPort) });
      expect(await task.closed).toBe(5);
      expect(task.output()).toContain("0.0.0-old");
      expect(task.output()).toContain("--restart");
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }
);

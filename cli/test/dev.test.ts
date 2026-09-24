import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { developmentPreflight } from "../src/dev.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
const processes: ChildProcess[] = [];
let home = "";

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    [...roots.splice(0), home].filter(Boolean).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "nylorun-home-")));
});

async function fixture(app = true, studio = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nylorun-dev-")));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"type":"module","name":"dev-demo"}');
  if (app) {
    await mkdir(join(root, "node_modules/tsx"), { recursive: true });
    await writeFile(
      join(root, "node_modules/tsx/package.json"),
      '{"type":"module","exports":{"./cli":"./cli.js"}}',
    );
    // Mock tsx: register a .ts loader (fixture agents are JS-shaped) then run entry.
    await writeFile(
      join(root, "node_modules/tsx/cli.js"),
      `
import {writeFileSync} from 'node:fs';
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';
writeFileSync('app.json', JSON.stringify({args:process.argv.slice(2)}));
process.on('SIGTERM',()=>writeFileSync('app-stopped','yes'));
register('data:text/javascript,' + encodeURIComponent(\`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: readFileSync(fileURLToPath(url), 'utf8'),
    };
  }
  return nextLoad(url, context);
}
\`), pathToFileURL('./'));
try { await import(pathToFileURL(process.argv[4]).href); }
catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeFileSync('app-stopped', 'yes');
}
`,
    );
  }
  if (studio) {
    await mkdir(join(root, "node_modules/@nylorun/studio"), {
      recursive: true,
    });
    await writeFile(
      join(root, "node_modules/@nylorun/studio/package.json"),
      '{"type":"module","exports":"./index.js"}',
    );
    await writeFile(
      join(root, "node_modules/@nylorun/studio/index.js"),
      `
import {writeFileSync} from 'node:fs';
export async function startStudio(options) {
  writeFileSync('studio.json',JSON.stringify(options));
  const timer=setInterval(()=>{},1000);
  return {address:'http://localhost:4161',close:async()=>{clearInterval(timer);writeFileSync('studio-stopped','yes');}};
}`,
    );
  }
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, "agents/index.ts"),
    `import { Agent } from ${JSON.stringify(
      new URL("../../core/dist/define.js", import.meta.url).href,
    )}; export const agents=[Agent({id:"test",name:"Test"}).build()];`,
  );
  return root;
}

function run(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  command = "dev",
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
    child.once("close", (code) => resolve(code)),
  );
  return { child, closed, output: () => output };
}

async function wait(check: () => Promise<void>, ms = 20_000) {
  const deadline = Date.now() + ms;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (failure) {
      error = failure;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw error;
}

it("rejects invalid setup before starting children", async () => {
  const root = await fixture(false, false);
  const previous = process.cwd();
  try {
    process.chdir(root);
    expect(() => developmentPreflight([])).toThrow("Install tsx");
  } finally {
    process.chdir(previous);
  }
  const withTsx = await fixture(true, false);
  try {
    process.chdir(withTsx);
    expect(() => developmentPreflight([])).toThrow("Install @nylorun/studio");
  } finally {
    process.chdir(previous);
  }
  const task = run(root, ["--bad"]);
  expect(await task.closed).toBe(2);
  expect(task.output()).toMatch(/nylorun <|Usage:/);
});

it("rejects removed --global flag", async () => {
  const root = await fixture();
  const task = run(root, ["--global", "--no-open"]);
  expect(await task.closed).toBe(2);
  expect(task.output()).toContain("--global was removed");
});

it(
  "F9: ephemeral dev writes Project link, prints banner, removes Host on exit",
  { timeout: 60_000 },
  async () => {
    const root = await fixture();
    const task = run(root, ["--no-open", "--ephemeral"]);
    await wait(async () => {
      expect(task.output()).toContain("Host");
      expect(task.output()).toContain("(ephemeral; removed on exit)");
      expect(task.output()).toContain("Tenant");
      expect(task.output()).toContain("Ctrl-C stops this Project only.");
      expect(
        JSON.parse(await readFile(join(root, ".nylorun/link.json"), "utf8"))
          .tenantId,
      ).toMatch(/^tn_/);
      expect(
        JSON.parse(
          await readFile(join(root, ".nylorun/credentials.json"), "utf8"),
        ).applicationKey,
      ).toMatch(/^[0-9a-f]{64}$/);
      expect(
        JSON.parse(await readFile(join(root, "studio.json"), "utf8")),
      ).toMatchObject({
        tenant: { id: expect.stringMatching(/^tn_/) },
        open: false,
      });
    });
    task.child.kill("SIGTERM");
    expect(await task.closed).toBe(0);
    expect(await readFile(join(root, "app-stopped"), "utf8")).toBe("yes");
    expect(await readFile(join(root, "studio-stopped"), "utf8")).toBe("yes");
  },
);

it(
  "F4/F5: ephemeral serve registers agents and prints Host banner",
  { timeout: 60_000 },
  async () => {
    const root = await fixture(false, false);
    await mkdir(join(root, "dist/agents"), { recursive: true });
    await writeFile(
      join(root, "dist/agents/index.js"),
      `
import { Agent } from ${JSON.stringify(
        new URL("../../core/dist/define.js", import.meta.url).href,
      )};
export const agents = [Agent({id:"test",name:"Serve"}).build()];
`,
    );
    const task = run(root, ["--ephemeral"], {}, "serve");
    await wait(async () => {
      expect(task.output()).toContain("(ephemeral; removed on exit)");
      expect(task.output()).toContain("Ready");
      const link = JSON.parse(
        await readFile(join(root, ".nylorun/link.json"), "utf8"),
      );
      const credentials = JSON.parse(
        await readFile(join(root, ".nylorun/credentials.json"), "utf8"),
      );
      expect(credentials.executors.test).toMatch(/^[0-9a-f]{64}$/);
      const response = await fetch(`${link.hostUrl}/v1/agents`, {
        headers: {
          authorization: `Bearer ${credentials.applicationKey}`,
          "Nylorun-Tenant": link.tenantId,
          "Nylorun-Protocol": "2",
        },
      });
      expect(response.ok).toBe(true);
      const body = (await response.json()) as {
        agents: { manifest: { name: string } }[];
      };
      expect(body.agents[0]?.manifest.name).toBe("Serve");
    });
    task.child.kill("SIGTERM");
    expect(await task.closed).toBe(0);
  },
);

it(
  "refuses --no-autostart when no Host is up",
  { timeout: 15_000 },
  async () => {
    const root = await fixture();
    const task = run(root, ["--no-open", "--no-autostart"]);
    expect(await task.closed).toBe(6);
    expect(task.output()).toMatch(/No Runtime Host is listening/);
  },
);

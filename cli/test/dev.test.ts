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
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const homeRef = { value: "" };
const tenantId = "tn_01TESTDEV0000000000000001";

vi.mock("../src/runtime/launcher.js", () => ({
  resolveHome: () => homeRef.value || "/tmp/nylorun-home",
  throwOnLauncherFailure: () => {},
  launcher: async () => ({
    home: homeRef.value,
    build: { path: "", version: "0.9.0-beta", launcher: "" },
    invoke: async () => ({
      events: [],
      result: {
        url: "http://127.0.0.1:9876",
        hostId: "host_01habcdefghijklmnopqrstuv",
        pid: 1,
        version: "0.9.0-beta",
        started: true,
      },
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
    invokeStreaming: async () => ({
      events: [],
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
  }),
}));

vi.mock("../src/runtime/version.js", () => ({
  runtimeVersion: () => "0.9.0-beta",
}));

vi.mock("../src/project/attach.js", async () => {
  const actual = await vi.importActual<typeof import("../src/project/attach.js")>(
    "../src/project/attach.js",
  );
  return {
    ...actual,
    attachProject: async ({ projectRoot }: { projectRoot: string }) => {
      const { writeLink } = await import("../src/project/link.js");
      const { writeCredentials } = await import("../src/project/credentials.js");
      await writeLink(projectRoot, {
        hostUrl: "http://127.0.0.1:9876",
        hostId: "host_01habcdefghijklmnopqrstuv",
        tenantId,
      });
      await writeCredentials(projectRoot, {
        applicationKey: "ab".repeat(32),
        principalId: "pr_test",
      });
      return {
        projectRoot,
        link: {
          format: 1 as const,
          hostUrl: "http://127.0.0.1:9876",
          hostId: "host_01habcdefghijklmnopqrstuv",
          tenantId,
        },
        credentials: {
          format: 1 as const,
          applicationKey: "ab".repeat(32),
          principalId: "pr_test",
        },
        host: {
          url: "http://127.0.0.1:9876",
          hostId: "host_01habcdefghijklmnopqrstuv",
          pid: 1,
          version: "0.9.0-beta",
          started: true,
        },
        tenantName: "dev-demo",
        hostStarted: true,
        home: homeRef.value,
      };
    },
  };
});

vi.mock("../src/project/seed.js", () => ({
  seedTenantFromProject: async () => ({ applied: [], kept: [] }),
}));

import { develop, developmentPreflight } from "../src/dev.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    [...roots.splice(0), homeRef.value].filter(Boolean).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

beforeEach(async () => {
  homeRef.value = await realpath(
    await mkdtemp(join(tmpdir(), "nylorun-home-")),
  );
});

async function fixture(app = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nylorun-dev-")));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    '{"type":"module","name":"dev-demo"}',
  );
  if (app) {
    await mkdir(join(root, "node_modules/tsx"), { recursive: true });
    await writeFile(
      join(root, "node_modules/tsx/package.json"),
      '{"type":"module","exports":{"./cli":"./cli.js"}}',
    );
    await writeFile(
      join(root, "node_modules/tsx/cli.js"),
      `
import {writeFileSync} from 'node:fs';
writeFileSync('app.json', JSON.stringify({
  args: process.argv.slice(2),
  env: {
    url: process.env.NYLORUN_RUNTIME_URL,
    tenant: process.env.NYLORUN_TENANT,
    key: process.env.NYLORUN_SERVER_KEY,
  },
}));
process.on('SIGTERM',()=>{ try { writeFileSync('app-stopped','yes'); } catch {} process.exit(0); });
process.on('SIGINT',()=>{ try { writeFileSync('app-stopped','yes'); } catch {} process.exit(0); });
setInterval(()=>{}, 1000);
`,
    );
  }
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/main.ts"), `console.log("main");\n`);
  return root;
}

it("F2-1: preflight requires tsx only (no Studio) and defaults entry", async () => {
  const root = await fixture(false);
  const previous = process.cwd();
  try {
    process.chdir(root);
    expect(() => developmentPreflight([])).toThrow("Install tsx");
  } finally {
    process.chdir(previous);
  }
  const withTsx = await fixture(true);
  try {
    process.chdir(withTsx);
    expect(developmentPreflight([])).toMatchObject({
      entry: "src/main.ts",
      ephemeral: false,
    });
    expect(developmentPreflight(["agents/index.ts"]).entry).toBe(
      "agents/index.ts",
    );
    expect(() => developmentPreflight(["--no-studio"])).toThrow(/Usage:/);
  } finally {
    process.chdir(previous);
  }
});

it("rejects removed --global via CLI", async () => {
  const root = await fixture();
  const child = spawn(process.execPath, [cli, "dev", "--global"], {
    cwd: root,
    env: { ...process.env, NYLORUN_HOME: homeRef.value },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  expect(
    await new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    ),
  ).toBe(2);
  expect(output).toContain("--global was removed");
});

it("F2-5: serve and studio commands are removed", async () => {
  const root = await fixture();
  for (const command of ["serve", "studio"] as const) {
    const child = spawn(process.execPath, [cli, command], {
      cwd: root,
      env: { ...process.env, NYLORUN_HOME: homeRef.value },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    let output = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    expect(
      await new Promise<number | null>((resolve) =>
        child.once("close", (code) => resolve(code)),
      ),
    ).toBe(2);
    expect(output).toMatch(/removed/);
  }
});

it(
  "F2-1: develop spawns tsx watch with three env vars and Studio banner",
  { timeout: 15_000 },
  async () => {
    const root = await fixture();
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const runPromise = develop({ projectRoot: root, home: homeRef.value });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const tick = async () => {
          try {
            const app = JSON.parse(
              await readFile(join(root, "app.json"), "utf8"),
            ) as {
              args: string[];
              env: { url: string; tenant: string; key: string };
            };
            expect(app.args).toContain("watch");
            expect(app.args.some((a) => a.endsWith("src/main.ts"))).toBe(true);
            expect(app.env).toEqual({
              url: "http://127.0.0.1:9876",
              tenant: tenantId,
              key: "ab".repeat(32),
            });
            expect(
              logs.some((line) => line.includes("Studio: npm run studio")),
            ).toBe(true);
            expect(logs.some((line) => line.includes("(started; stays running)"))).toBe(
              true,
            );
            resolve();
            return;
          } catch (error) {
            if (Date.now() > deadline) reject(error);
            else setTimeout(tick, 50);
          }
        };
        void tick();
      });
    } finally {
      console.log = original;
      const { execSync } = await import("node:child_process");
      try {
        execSync(
          `pkill -f ${JSON.stringify(join(root, "node_modules/tsx/cli.js"))} || true`,
        );
      } catch {
        /* ignore */
      }
      await Promise.race([
        runPromise,
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
  },
);

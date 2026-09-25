/**
 * Desktop contract smoke (WS-J / D18): Babai's D§15 flow headlessly.
 *
 * The developer prerequisite is installed first (`@nylorun/runtime`, here the
 * workspace package in a private npm prefix). Launcher resolution is then
 * implemented here independently of the CLI, as a desktop client would:
 * find `nylorun-runtime` on PATH and run it with --json.
 *
 * Usage:
 *   node scripts/smoke-desktop-contract.mjs
 *   node --test scripts/test/desktop-contract.test.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Agent, connectAgents, createClient, RuntimeError } from "@nylorun/agents";
import { createAdmin, AdminError } from "@nylorun/admin";
import { readJson, root } from "./lib/repo.mjs";
import { installRuntime } from "./lib/runtime-install.mjs";

/**
 * Find the installed launcher on PATH (D§9.1), independent of CLI source.
 * npm links the bin to `dist/launcher/main.js`: a symlink on POSIX, a `.cmd`
 * shim beside `node_modules/@nylorun/runtime` on Windows. Returns the script
 * to run on this Node, so Windows never needs a shell for `.cmd`.
 */
export function resolveLauncher(env = process.env) {
  const windows = process.platform === "win32";
  const name = windows ? "nylorun-runtime.cmd" : "nylorun-runtime";
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, name);
    try {
      if (!statSync(bin).isFile()) continue;
    } catch {
      continue;
    }
    if (!windows) return { bin, script: realpathSync(bin) };
    const main = join("@nylorun", "runtime", "dist", "launcher", "main.js");
    for (const script of [join(dir, "node_modules", main), join(dir, "..", main)])
      if (existsSync(script)) return { bin, script };
  }
  return undefined;
}

/**
 * Run nylorun-runtime with --json; return { result, error, events, exitCode }.
 */
export async function runLauncher(home, args, env = process.env) {
  const launcher = resolveLauncher(env);
  if (!launcher)
    throw new Error(
      "nylorun-runtime is not on PATH; install @nylorun/runtime first.",
    );
  const child = spawn(
    process.execPath,
    [launcher.script, "--home", home, "--json", ...args],
    {
      env: { ...env, NYLORUN_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  /** @type {object[]} */
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* ignore non-JSON progress text */
    }
  }
  const result = events.find((e) => e?.type === "result");
  const error = events.find((e) => e?.type === "error");
  return { result, error, events, exitCode, stdout, stderr };
}

function fixtureAgent() {
  return Agent({
    id: "desktop-probe",
    name: "Desktop probe",
    instructions: "Contract smoke agent; do not call tools.",
    tools: [],
  });
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * J1 + J2 happy path on one temporary home.
 */
export async function runHappyPath({ home, env, version, log = () => {} }) {
  log("J1: prerequisite Runtime on PATH");
  const found = await runLauncher(home, ["version"], env);
  assert.equal(found.exitCode, 0, found.stderr || JSON.stringify(found.error));
  assert.equal(found.result?.runtimeVersion, version);
  assert.equal(found.result?.launcherProtocol, 1);
  assert.equal(found.result?.node, process.versions.node);

  log("J1: up");
  const up1 = await runLauncher(home, ["up", "--port", "0"], env);
  assert.equal(up1.exitCode, 0, up1.stderr || JSON.stringify(up1.error));
  assert.equal(up1.result?.started, true);
  assert.match(up1.result.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(up1.result.version, version);

  log("J1: createTenant");
  const admin = createAdmin({ home });
  const created = await admin.createTenant({ name: "Babai" });
  assert.match(created.tenant.id, /^tn_/);
  assert.match(created.applicationKey, /^[0-9a-f]{64}$/);
  const stored = {
    tenantId: created.tenant.id,
    applicationKey: created.applicationKey,
  };

  log("J1: connectAgents + session");
  const agent = fixtureAgent();
  const connection = connectAgents({
    agents: [agent],
    application: createClient({
      url: up1.result.url,
      tenant: stored.tenantId,
      key: stored.applicationKey,
    }),
    implementationVersion: "desktop-contract-smoke",
    onError: () => {},
  });
  await connection.ready;
  const client = createClient({
    url: up1.result.url,
    tenant: stored.tenantId,
    key: stored.applicationKey,
  });
  const session = await client.createSession({
    agentId: agent.id,
    ownerUserId: "desktop-smoke",
  });
  assert.ok(session.id);
  await connection.close();

  log("J1: admin.status");
  const status = await admin.status();
  assert.equal(status.service, "nylorun-runtime");
  assert.ok(status.tenants.some((t) => t.id === stored.tenantId));
  assert.ok(status.host?.hostId);
  assert.equal(status.host?.url, up1.result.url);

  log("J2: second up while running");
  const up2 = await runLauncher(home, ["up"], env);
  assert.equal(up2.exitCode, 0, up2.stderr || JSON.stringify(up2.error));
  assert.equal(up2.result?.started, false);
  assert.equal(up2.result.pid, up1.result.pid);
  assert.equal(up2.result.url, up1.result.url);

  // Key already supplied (safeStorage analogue): do not createTenant again.
  const before = await admin.listTenants();
  assert.equal(
    before.filter((t) => t.id === stored.tenantId).length,
    1,
  );
  assert.equal(before.length, 1, "no second Tenant when key is supplied");

  return { up: up1.result, stored, admin, client };
}

/**
 * J3: deleted Tenant → opaque Tenant API 404; getTenant confirms gone.
 */
export async function runDeletedTenantCase({ admin, client, stored }) {
  await admin.deleteTenant(stored.tenantId, { activeWork: "cancel" });
  await assert.rejects(
    () => client.listAgents(),
    (error) => {
      assert.ok(error instanceof RuntimeError);
      assert.equal(error.status, 404);
      assert.equal(error.body?.code, "not_found");
      assert.equal(error.body?.message, "Not found");
      return true;
    },
  );
  await assert.rejects(
    () => admin.getTenant(stored.tenantId),
    (error) => {
      assert.ok(error instanceof AdminError);
      assert.equal(error.code, "not_found");
      return true;
    },
  );
}

/**
 * J3: incompatible_host from Admin when /health features mismatch.
 */
export async function runIncompatibleHostCase() {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "nylorun-runtime",
          version: "9.9.9",
          protocol: { min: 2, max: 2, features: [] },
          hostId: "host_00000000000000000000000099",
          pid: 1,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const admin = createAdmin({ url, key: "a".repeat(64) });
    await assert.rejects(() => admin.listTenants(), (error) => {
      assert.ok(error instanceof AdminError);
      assert.equal(error.code, "incompatible_host");
      return true;
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

/**
 * J3: host_schema_newer from crafted tenant.json via launcher up.
 */
export async function runHostSchemaNewerCase({ env, log = () => {} }) {
  const home = await mkdtemp(join(tmpdir(), "nylorun-desktop-schema-"));
  try {
    const tenantId = "tn_0123456789abcdefghjkmnpqrs";
    await mkdir(join(home, "tenants", tenantId), { recursive: true });
    await writeFile(
      join(home, "tenants", tenantId, "tenant.json"),
      JSON.stringify({
        id: tenantId,
        name: "future",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: 99,
      }),
    );
    log("J3: up with host_schema_newer");
    const up = await runLauncher(home, ["up", "--port", "0"], env);
    assert.equal(up.exitCode, 1);
    assert.equal(up.error?.code, "host_schema_newer");
    assert.ok(typeof up.error?.remedy === "string" && up.error.remedy.length > 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * J3: foreign_port when something else answers on the configured port.
 */
export async function runForeignPortCase({ env, log = () => {} }) {
  const home = await mkdtemp(join(tmpdir(), "nylorun-desktop-foreign-"));
  const foreign = createServer((_req, res) => {
    res.writeHead(200);
    res.end("not-nylorun");
  });
  try {
    const foreignPort = await new Promise((resolve, reject) => {
      foreign.listen(0, "127.0.0.1", () => {
        const address = foreign.address();
        if (!address || typeof address === "string") reject(new Error("bind"));
        else resolve(address.port);
      });
    });
    log("J3: up against foreign_port");
    const up = await runLauncher(
      home,
      ["up", "--port", String(foreignPort)],
      env,
    );
    assert.equal(up.exitCode, 1);
    assert.equal(up.error?.code, "foreign_port");
    assert.ok(typeof up.error?.remedy === "string" && up.error.remedy.length > 0);
  } finally {
    await new Promise((resolve) => foreign.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * J4: any Origin header is rejected (renderer rule).
 */
export async function runOriginRejectedCase(hostUrl) {
  const response = await fetch(`${hostUrl}/health`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.status, "rejected");
  assert.equal(body.code, "origin_rejected");
  for (const name of response.headers.keys()) {
    assert.ok(
      !name.toLowerCase().startsWith("access-control-"),
      `unexpected CORS header ${name}`,
    );
  }
}

/**
 * Full J1–J4 desktop contract against a temporary home, with the workspace
 * Runtime installed as the prerequisite in a temporary npm prefix.
 */
export async function runDesktopContractSmoke({
  log = console.log,
  keepHome = false,
} = {}) {
  const prefix = await mkdtemp(join(tmpdir(), "nylorun-desktop-runtime-"));
  const home = await mkdtemp(join(tmpdir(), "nylorun-desktop-home-"));
  const version = (await readJson(join(root, "runtime/package.json"))).version;
  const env = (await installRuntime(prefix)).env();
  let happy;
  try {
    log(`Using @nylorun/runtime@${version} from ${prefix}`);
    log(`NYLORUN_HOME=${home}`);

    happy = await runHappyPath({ home, env, version, log });

    log("J3: deleted Tenant");
    await runDeletedTenantCase({
      admin: happy.admin,
      client: happy.client,
      stored: happy.stored,
    });

    log("J3: incompatible_host");
    await runIncompatibleHostCase();

    log("J3: host_schema_newer");
    await runHostSchemaNewerCase({ env, log });

    log("J3: foreign_port");
    await runForeignPortCase({ env, log });

    log("J4: Origin rejected");
    await runOriginRejectedCase(happy.up.url);

    log("J1: down");
    const down = await runLauncher(home, ["down", "--force"], env);
    assert.equal(down.exitCode, 0, down.stderr || JSON.stringify(down.error));
    assert.equal(down.result?.stopped, true);

    log("Desktop contract smoke passed (J1–J4).");
    return { home, version };
  } finally {
    if (happy?.up) {
      try {
        await runLauncher(home, ["down", "--force"], env);
      } catch {
        /* best-effort */
      }
      await wait(200);
    }
    if (!keepHome) await rm(home, { recursive: true, force: true });
    await rm(prefix, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  runDesktopContractSmoke()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

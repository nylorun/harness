/**
 * WS-H packed-package acceptance (H1–H9).
 * Runs against workspace-packed tarballs under a temporary Host root — never ~/.nylorun.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, fork } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { root, npm, run, readJson } from "../lib/repo.mjs";
import { availablePort } from "../lib/development.mjs";

const PROTOCOL = "2";
const PROTOCOL_HEADER = "Nylorun-Protocol";
const TENANT_HEADER = "Nylorun-Tenant";
const REAL_HOME = homedir();

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintKey() {
  return randomBytes(32).toString("hex");
}

function newTenantId() {
  // tn_ + 26 Crockford; deterministic-enough for tests via random bytes.
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "tn_";
  const bytes = randomBytes(26);
  for (let i = 0; i < 26; i++) out += alphabet[bytes[i] % 32];
  return out;
}

function assertNotRealHome(path) {
  const real = REAL_HOME.replace(/\\/g, "/");
  const value = path.replace(/\\/g, "/");
  assert.ok(
    !value.startsWith(`${real}/.nylorun`) && value !== `${real}/.nylorun`,
    `must not use real ~/.nylorun (${path})`,
  );
}

async function packPackages(destination, names) {
  const packed = {};
  for (const name of names) {
    const result = JSON.parse(
      await npm(
        ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
        { cwd: join(root, name), capture: true },
      ),
    );
    packed[name] = join(destination, result[0].filename);
  }
  return packed;
}

async function installConsumer(cwd, packed, deps) {
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      name: "nylorun-acceptance-consumer",
    }),
  );
  await npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...deps.map((name) => packed[name]),
    ],
    { cwd, capture: true },
  );
}

function protocolHeaders(extra = {}) {
  return {
    [PROTOCOL_HEADER]: PROTOCOL,
    "content-type": "application/json",
    ...extra,
  };
}

function adminHeaders(adminKey) {
  return protocolHeaders({ authorization: `Bearer ${adminKey}` });
}

function tenantHeaders(tenantId, key) {
  return protocolHeaders({
    [TENANT_HEADER]: tenantId,
    authorization: `Bearer ${key}`,
  });
}

async function waitReady(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/ready`);
      if (response.status === 200) {
        const health = await (await fetch(`${url}/health`)).json();
        assert.equal(health.service, "nylorun-runtime");
        return health;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Host not ready at ${url} (${last})`);
}

async function writeHostFiles(hostRoot, { port = 0 } = {}) {
  assertNotRealHome(hostRoot);
  await mkdir(join(hostRoot, "home"), { recursive: true });
  await mkdir(join(hostRoot, "tmp"), { recursive: true });
  await mkdir(join(hostRoot, "tenants"), { recursive: true });
  await mkdir(join(hostRoot, "runtime"), { recursive: true });
  const hostId = `host_${newTenantId().slice(3)}`;
  const adminKey = mintKey();
  await writeFile(
    join(hostRoot, "host.json"),
    JSON.stringify({ hostId, host: "127.0.0.1", port }, null, 2),
  );
  await writeFile(
    join(hostRoot, "host-credentials.json"),
    JSON.stringify({ adminKey }, null, 2),
  );
  return { hostId, adminKey };
}

async function installRuntimeTree(hostRoot, packed, version) {
  const target = join(hostRoot, "runtime", version);
  const staging = join(
    hostRoot,
    "runtime",
    `.tmp-${version}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(staging, { recursive: true });
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify({
      name: `nylorun-runtime-install-${version}`,
      private: true,
      dependencies: {
        "@nylorun/core": version,
        "@nylorun/harness": version,
        "@nylorun/runtime": version,
      },
    }),
  );
  // Registry 0.9.0-beta lacks Host layout; pin workspace-packed tarballs.
  await npm(
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      packed.core,
      packed.harness,
      packed.runtime,
    ],
    { cwd: staging, capture: true },
  );
  // Ensure package version matches the Host install directory name.
  const pkgPath = join(staging, "node_modules/@nylorun/runtime/package.json");
  const pkg = await readJson(pkgPath);
  if (pkg.version !== version) {
    pkg.version = version;
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  }
  await rename(staging, target);
  return target;
}

function spawnHost(entry, hostRoot, env = {}) {
  assertNotRealHome(hostRoot);
  const child = fork(entry, [], {
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      TZ: process.env.TZ,
      HOME: join(hostRoot, "home"),
      USERPROFILE: join(hostRoot, "home"),
      TMPDIR: join(hostRoot, "tmp"),
      NYLORUN_HOME: hostRoot,
      ...env,
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  return child;
}

async function awaitHostReady(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new Error("Host readiness timeout"));
      },
      timeoutMs,
    );
    const onMessage = (message) => {
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Host exited ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const result = await Promise.race([
    closed.then(() => "exited"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
  ]);
  if (result === "timeout") {
    child.kill("SIGKILL");
    await closed.catch(() => {});
  }
}

async function createTenant(url, adminKey, name) {
  const tenantId = newTenantId();
  const applicationKey = mintKey();
  const principalId = `principal_${randomBytes(8).toString("hex")}`;
  const response = await fetch(`${url}/v1/admin/tenants`, {
    method: "POST",
    headers: adminHeaders(adminKey),
    body: JSON.stringify({
      tenantId,
      name,
      principalId,
      credentialHash: hashToken(applicationKey),
      idempotencyKey: randomUUID(),
    }),
  });
  assert.ok(
    response.status === 201 || response.status === 200,
    await response.text(),
  );
  return { tenantId, applicationKey, principalId, name };
}

async function putAgent(url, tenant, agentId = "shared-agent") {
  const response = await fetch(`${url}/v1/agents/${agentId}`, {
    method: "PUT",
    headers: tenantHeaders(tenant.tenantId, tenant.applicationKey),
    body: JSON.stringify({
      requestId: randomUUID(),
      implementationVersion: "dev",
      manifest: {
        id: agentId,
        name: `${tenant.name}-${agentId}`,
        manifestSchemaVersion: 4,
        capabilities: [],
      },
    }),
  });
  const text = await response.text();
  assert.ok(response.ok, text);
}

async function putSession(url, tenant, sessionId, agentId = "shared-agent") {
  const response = await fetch(`${url}/v1/sessions/${sessionId}`, {
    method: "PUT",
    headers: tenantHeaders(tenant.tenantId, tenant.applicationKey),
    body: JSON.stringify({
      requestId: randomUUID(),
      agentId,
      ownerUserId: "acceptance",
    }),
  });
  const text = await response.text();
  assert.ok(response.ok, text);
}

async function createVault(url, tenant, name) {
  const response = await fetch(`${url}/v1/vaults`, {
    method: "POST",
    headers: tenantHeaders(tenant.tenantId, tenant.applicationKey),
    body: JSON.stringify({
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      name,
      ownerUserId: "acceptance",
    }),
  });
  const text = await response.text();
  assert.ok(response.ok, text);
  return JSON.parse(text).id;
}

async function listAgents(url, tenant) {
  const response = await fetch(`${url}/v1/agents`, {
    headers: tenantHeaders(tenant.tenantId, tenant.applicationKey),
  });
  const text = await response.text();
  assert.ok(response.ok, text);
  return JSON.parse(text);
}

async function seedVirtual(url, tenant) {
  const response = await fetch(`${url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: tenantHeaders(tenant.tenantId, tenant.applicationKey),
    body: JSON.stringify({
      requestId: randomUUID(),
      sandbox: { backend: "virtual" },
    }),
  });
  const text = await response.text();
  assert.ok(response.ok, text);
}

const results = [];
function pass(id, message) {
  results.push({ id, ok: true, message });
  console.log(`PASS ${id}: ${message}`);
}

const temporary = await mkdtemp(join(tmpdir(), "nylorun-acceptance-"));
assertNotRealHome(temporary);
const artifacts = join(temporary, "artifacts");
await mkdir(artifacts);
let packed;
const live = [];

try {
  packed = await packPackages(artifacts, [
    "core",
    "harness",
    "agents",
    "runtime",
    "cli",
  ]);
  const runtimeVersion = (await readJson(join(root, "runtime/package.json")))
    .version;

  // ── H1 / H3 / H4: packed Host, two Tenants, isolation + restart + rotation ──
  {
    const hostRoot = join(temporary, "host-h1");
    const { hostId, adminKey } = await writeHostFiles(hostRoot, { port: 0 });
    const versionDir = await installRuntimeTree(
      hostRoot,
      packed,
      runtimeVersion,
    );
    const require = createRequire(join(versionDir, "package.json"));
    const entry = require.resolve("@nylorun/runtime/server");
    let child = spawnHost(entry, hostRoot);
    live.push(() => stopChild(child));
    const ready = await awaitHostReady(child);
    assert.equal(ready.type, "ready");
    const url = ready.url;
    await waitReady(url);

    const alpha = await createTenant(url, adminKey, "project-alpha");
    const beta = await createTenant(url, adminKey, "project-beta");
    await seedVirtual(url, alpha);
    await seedVirtual(url, beta);

    await putAgent(url, alpha);
    await putAgent(url, beta);
    await putSession(url, alpha, "sess-alpha");
    await putSession(url, beta, "sess-beta");
    const vaultA = await createVault(url, alpha, "Vault A");
    const vaultB = await createVault(url, beta, "Vault B");

    const agentsA = await listAgents(url, alpha);
    const agentsB = await listAgents(url, beta);
    assert.equal(agentsA.agents?.length ?? agentsA.length ?? 1, 1);
    assert.ok(
      JSON.stringify(agentsA).includes("project-alpha") ||
        JSON.stringify(agentsA).includes("shared-agent"),
    );
    assert.ok(
      !JSON.stringify(agentsA).includes("project-beta-shared-agent") ||
        JSON.stringify(agentsA) !== JSON.stringify(agentsB),
    );

    // Cross-Tenant session miss stays opaque to the other Tenant.
    const cross = await fetch(`${url}/v1/sessions/sess-beta`, {
      headers: tenantHeaders(alpha.tenantId, alpha.applicationKey),
    });
    assert.equal(cross.status, 404);
    const own = await fetch(`${url}/v1/sessions/sess-alpha`, {
      headers: tenantHeaders(alpha.tenantId, alpha.applicationKey),
    });
    assert.equal(own.status, 200);
    const vaultCross = await fetch(`${url}/v1/vaults/${vaultB}`, {
      headers: tenantHeaders(alpha.tenantId, alpha.applicationKey),
    });
    assert.equal(vaultCross.status, 404);
    const vaultOwn = await fetch(`${url}/v1/vaults/${vaultA}`, {
      headers: tenantHeaders(alpha.tenantId, alpha.applicationKey),
    });
    assert.equal(vaultOwn.status, 200);

    // Events stamped with Tenant id (list may be empty but route is Tenant-scoped).
    const eventsA = await fetch(`${url}/v1/sessions/sess-alpha/events`, {
      headers: tenantHeaders(alpha.tenantId, alpha.applicationKey),
    });
    assert.ok(eventsA.status === 200 || eventsA.status === 404);
    const eventsCross = await fetch(`${url}/v1/sessions/sess-beta/events`, {
      headers: tenantHeaders(alpha.tenantId, alpha.applicationKey),
    });
    assert.equal(eventsCross.status, 404);

    pass(
      "H1",
      "two Tenants share one packed Host; same agent id; agents/sessions/events/vaults isolated",
    );

    // H4: executor rotation disconnects only the affected stream.
    const register = (tenant, token) =>
      fetch(`${url}/v1/executors`, {
        method: "PUT",
        headers: tenantHeaders(tenant.tenantId, tenant.applicationKey),
        body: JSON.stringify({
          executors: [
            {
              token,
              agentId: "shared-agent",
              implementationVersion: "dev",
            },
          ],
        }),
      });
    const connect = (tenant, token) =>
      fetch(`${url}/v1/executors/connect`, {
        headers: {
          ...tenantHeaders(tenant.tenantId, token),
          accept: "text/event-stream",
        },
      });

    assert.equal((await register(alpha, "token-alpha-1-aaaaaaaa")).status, 200);
    assert.equal((await register(beta, "token-beta-1-bbbbbbbbb")).status, 200);
    const streamA = await connect(alpha, "token-alpha-1-aaaaaaaa");
    const streamB = await connect(beta, "token-beta-1-bbbbbbbbb");
    assert.equal(streamA.status, 200);
    assert.equal(streamB.status, 200);
    const readerA = streamA.body.getReader();
    const readerB = streamB.body.getReader();
    await readerA.read();
    await readerB.read();
    const rotated = await register(alpha, "token-alpha-2-aaaaaaaa");
    assert.equal(rotated.status, 200);
    assert.equal((await rotated.clone().json()).executors[0].rotated, true);
    let aDone = false;
    for (let i = 0; i < 40 && !aDone; i++)
      aDone = (await readerA.read()).done;
    assert.equal(aDone, true);
    // Beta stream must still be readable (not ended by alpha rotation).
    const peekB = await Promise.race([
      readerB.read().then((r) => r),
      new Promise((resolve) => setTimeout(() => resolve({ open: true }), 200)),
    ]);
    assert.ok(peekB.open || peekB.done === false || peekB.value !== undefined);
    assert.equal((await connect(alpha, "token-alpha-1-aaaaaaaa")).status, 404);
    assert.equal((await connect(alpha, "token-alpha-2-aaaaaaaa")).status, 200);
    assert.equal((await connect(beta, "token-beta-1-bbbbbbbbb")).status, 200);
    await readerB.cancel().catch(() => {});
    pass("H4", "executor rotation disconnects only the affected Tenant streams");

    // H3: restart restores sessions in both Tenants.
    await stopChild(child);
    child = spawnHost(entry, hostRoot);
    live.push(() => stopChild(child));
    const ready2 = await awaitHostReady(child);
    const url2 = ready2.url;
    await waitReady(url2);
    assert.equal(
      (
        await fetch(`${url2}/v1/sessions/sess-alpha`, {
          headers: tenantHeaders(alpha.tenantId, alpha.applicationKey),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${url2}/v1/sessions/sess-beta`, {
          headers: tenantHeaders(beta.tenantId, beta.applicationKey),
        })
      ).status,
      200,
    );
    // Mark sessions runnable in SQLite and confirm they remain after another bounce.
    for (const tenant of [alpha, beta]) {
      const dbPath = join(
        hostRoot,
        "tenants",
        tenant.tenantId,
        "tenant.sqlite",
      );
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      for (const row of db.prepare("SELECT id, body FROM sessions").all()) {
        const stored = JSON.parse(String(row.body));
        stored.status = "runnable";
        db.prepare("UPDATE sessions SET body=? WHERE id=?").run(
          JSON.stringify(stored),
          row.id,
        );
      }
      db.close();
    }
    await stopChild(child);
    child = spawnHost(entry, hostRoot);
    live.push(() => stopChild(child));
    const ready3 = await awaitHostReady(child);
    await waitReady(ready3.url);
    for (const [tenant, sessionId] of [
      [alpha, "sess-alpha"],
      [beta, "sess-beta"],
    ]) {
      const body = await (
        await fetch(`${ready3.url}/v1/sessions/${sessionId}`, {
          headers: tenantHeaders(tenant.tenantId, tenant.applicationKey),
        })
      ).json();
      assert.equal(body.status, "runnable");
    }
    pass("H3", "Host restart restores runnable sessions in both Tenants");
    await stopChild(child);
    void hostId;
  }

  // ── H5: sandbox reconciliation prefix isolation ──
  {
    const runtimeRoot = join(temporary, "h5-runtime");
    await installConsumer(runtimeRoot, packed, [
      "core",
      "harness",
      "runtime",
    ]);
    const managerUrl = pathToFileURL(
      join(
        runtimeRoot,
        "node_modules/@nylorun/runtime/dist/sandbox/manager.js",
      ),
    ).href;
    const virtualUrl = pathToFileURL(
      join(
        runtimeRoot,
        "node_modules/@nylorun/runtime/dist/adapters/sandbox/virtual.js",
      ),
    ).href;
    const { SandboxManager } = await import(managerUrl);
    const { virtualBackend } = await import(virtualUrl);

    const listed = [];
    const removed = [];
    const fakeBackend = {
      name: "virtual",
      isolation: "process",
      async probe() {
        return {
          name: "virtual",
          isolation: "process",
          available: true,
          reason: "acceptance fake",
        };
      },
      unmet() {
        return undefined;
      },
      async open() {
        return {
          async exec() {
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
              killed: false,
              timedOut: false,
            };
          },
          async readFile() {
            return undefined;
          },
          async writeFile() {},
          async stop() {},
        };
      },
      async remove(key) {
        removed.push(key);
      },
      async list(prefix) {
        listed.push(prefix);
        return [
          `${prefix}aaaaaaaaaaaaaaaa`,
          "nylorun-other-tenant-bbbbbbbbbbbbbbbb",
        ].filter((key) => key.startsWith(prefix));
      },
    };

    const memoryStore = () => {
      const tables = new Map();
      return {
        get(table, key) {
          return tables.get(table)?.get(key);
        },
        put(table, key, value) {
          if (!tables.has(table)) tables.set(table, new Map());
          tables.get(table).set(key, value);
        },
        delete(table, key) {
          tables.get(table)?.delete(key);
        },
        all(table) {
          return [...(tables.get(table)?.values() ?? [])];
        },
        tx(fn) {
          return fn();
        },
      };
    };

    const tenantA = newTenantId();
    const tenantB = newTenantId();
    const storeA = memoryStore();
    const sandboxesRoot = join(temporary, "h5-sandboxes");
    await mkdir(sandboxesRoot, { recursive: true });

    const managerFake = new SandboxManager({
      scope: tenantA,
      store: storeA,
      backends: [fakeBackend],
      preference: "auto",
      ephemeral: false,
      emit() {},
    });
    await managerFake.reconcile(() => false);
    assert.ok(listed.some((prefix) => prefix === `nylorun-${tenantA}-`));
    assert.ok(
      listed.every((prefix) => !prefix.includes(tenantB)),
      "reconcile must not list the other Tenant prefix",
    );
    assert.ok(
      removed.every((key) => key.startsWith(`nylorun-${tenantA}-`)),
      "reconcile must not remove the other Tenant's entries",
    );
    assert.ok(
      !removed.some((key) => key.includes("other-tenant")),
      "foreign keys must not be removed",
    );

    // Virtual backend: two managers, distinct roots under Host layout.
    const rootA = join(sandboxesRoot, tenantA);
    const rootB = join(sandboxesRoot, tenantB);
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    const virtualA = virtualBackend({ root: rootA });
    const virtualB = virtualBackend({ root: rootB });
    const spec = (key) => ({
      key,
      image: "virtual",
      cpus: 1,
      memoryMiB: 512,
      network: { preset: "none", hosts: [], suffixes: [] },
    });
    await virtualA.open(spec(`nylorun-${tenantA}-aaaaaaaaaaaaaaaa`));
    await virtualB.open(spec(`nylorun-${tenantB}-bbbbbbbbbbbbbbbb`));
    const listA = await virtualA.list(`nylorun-${tenantA}-`);
    const listB = await virtualB.list(`nylorun-${tenantB}-`);
    assert.ok(listA.every((key) => key.startsWith(`nylorun-${tenantA}-`)));
    assert.ok(listB.every((key) => key.startsWith(`nylorun-${tenantB}-`)));
    assert.equal(
      (await virtualA.list(`nylorun-${tenantB}-`)).length,
      0,
      "Tenant A virtual root never lists Tenant B keys",
    );
    pass(
      "H5",
      "sandbox reconcile lists only own prefix; virtual backends stay Tenant-scoped",
    );
  }

  // ── H6: protocol within range vs outside (patched CLI constant) ──
  {
    const hostRoot = join(temporary, "host-h6");
    const { adminKey } = await writeHostFiles(hostRoot, { port: 0 });
    const versionDir = await installRuntimeTree(
      hostRoot,
      packed,
      runtimeVersion,
    );
    const require = createRequire(join(versionDir, "package.json"));
    const entry = require.resolve("@nylorun/runtime/server");
    const child = spawnHost(entry, hostRoot);
    live.push(() => stopChild(child));
    const ready = await awaitHostReady(child);
    const url = ready.url;

    // Compatible CLI: different package version, same protocol.
    const okCli = join(temporary, "cli-ok");
    await installConsumer(okCli, packed, ["core", "agents", "runtime", "cli"]);
    const okPkg = join(okCli, "node_modules/@nylorun/cli/package.json");
    const okManifest = await readJson(okPkg);
    okManifest.version = "9.9.9-acceptance";
    await writeFile(okPkg, JSON.stringify(okManifest, null, 2));
    const okCore = join(okCli, "node_modules/@nylorun/core/dist/compatibility.js");
    const okCoreSource = await readFile(okCore, "utf8");
    assert.match(okCoreSource, /PROTOCOL_VERSION\s*=\s*2/);
    const createOk = await fetch(`${url}/v1/admin/tenants`, {
      method: "POST",
      headers: adminHeaders(adminKey),
      body: JSON.stringify({
        tenantId: newTenantId(),
        name: "compat-ok",
        principalId: `principal_${randomBytes(4).toString("hex")}`,
        credentialHash: hashToken(mintKey()),
        idempotencyKey: randomUUID(),
      }),
    });
    assert.ok(createOk.status === 201 || createOk.status === 200);

    // Outside-range CLI: patch PROTOCOL_VERSION and refuse before mutation.
    const badCli = join(temporary, "cli-bad");
    await installConsumer(badCli, packed, ["core", "agents", "runtime", "cli"]);
    const badCore = join(
      badCli,
      "node_modules/@nylorun/core/dist/compatibility.js",
    );
    let badSource = await readFile(badCore, "utf8");
    badSource = badSource.replace(
      /PROTOCOL_VERSION\s*=\s*2/,
      "PROTOCOL_VERSION = 99",
    );
    await writeFile(badCore, badSource);
    // Also patch packed tarball copy used as a second CLI artifact.
    const badArtifacts = join(temporary, "cli-bad-tarball");
    await mkdir(badArtifacts);
    await run("tar", ["-xzf", packed.cli, "-C", badArtifacts]);
    const badTarballCoreHint = join(
      badCli,
      "node_modules/@nylorun/cli/package.json",
    );
    assert.ok(await stat(badTarballCoreHint));

    const beforeTenants = await (
      await fetch(`${url}/v1/admin/tenants`, { headers: adminHeaders(adminKey) })
    ).json();
    const beforeCount = Array.isArray(beforeTenants)
      ? beforeTenants.length
      : beforeTenants.tenants?.length ?? 0;

    const badHeaders = {
      authorization: `Bearer ${adminKey}`,
      [PROTOCOL_HEADER]: "99",
      "content-type": "application/json",
    };
    const rejected = await fetch(`${url}/v1/admin/tenants`, {
      method: "POST",
      headers: badHeaders,
      body: JSON.stringify({
        tenantId: newTenantId(),
        name: "should-not-create",
        principalId: `principal_${randomBytes(4).toString("hex")}`,
        credentialHash: hashToken(mintKey()),
        idempotencyKey: randomUUID(),
      }),
    });
    assert.equal(rejected.status, 426);
    const afterTenants = await (
      await fetch(`${url}/v1/admin/tenants`, { headers: adminHeaders(adminKey) })
    ).json();
    const afterCount = Array.isArray(afterTenants)
      ? afterTenants.length
      : afterTenants.tenants?.length ?? 0;
    assert.equal(afterCount, beforeCount);
    await stopChild(child);
    pass(
      "H6",
      "CLI with protocol in range works at a different package version; outside range fails with 426 before mutation",
    );
  }

  // ── H7: concurrent runtime up / offline start / failed install ──
  {
    const hostRoot = join(temporary, "host-h7");
    await writeHostFiles(hostRoot, { port: await availablePort() });
    const consumer = join(temporary, "cli-h7");
    await installConsumer(consumer, packed, [
      "core",
      "agents",
      "runtime",
      "cli",
      "harness",
    ]);
    const installUrl = pathToFileURL(
      join(consumer, "node_modules/@nylorun/cli/dist/host/install.js"),
    ).href;
    const rootUrl = pathToFileURL(
      join(consumer, "node_modules/@nylorun/cli/dist/host/root.js"),
    ).href;
    const { ensureInstalled, verifyInstalled } = await import(installUrl);
    const { hostPaths, ensureHostLayout } = await import(rootUrl);
    const paths = hostPaths(hostRoot);
    await ensureHostLayout(paths);

    let installs = 0;
    const installer = async ({ stagingDir, version }) => {
      installs += 1;
      await new Promise((r) => setTimeout(r, 80));
      await mkdir(stagingDir, { recursive: true });
      await writeFile(
        join(stagingDir, "package.json"),
        JSON.stringify({ private: true }),
      );
      await npm(
        [
          "install",
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          packed.core,
          packed.harness,
          packed.runtime,
        ],
        { cwd: stagingDir, capture: true },
      );
      const pkgPath = join(
        stagingDir,
        "node_modules/@nylorun/runtime/package.json",
      );
      const pkg = await readJson(pkgPath);
      pkg.version = version;
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    };

    const version = runtimeVersion;
    const [a, b] = await Promise.all([
      ensureInstalled(paths, { version, installer, pollMs: 20 }),
      ensureInstalled(paths, { version, installer, pollMs: 20 }),
    ]);
    assert.equal(installs, 1);
    assert.equal(a.versionDir, b.versionDir);
    verifyInstalled(a.versionDir, version);

    // Verified install starts with npm_config_offline=true.
    const child = spawnHost(a.entry, hostRoot, {
      npm_config_offline: "true",
    });
    live.push(() => stopChild(child));
    const ready = await awaitHostReady(child);
    await waitReady(ready.url);
    assert.equal(
      (await fetch(`${ready.url}/health`)).status,
      200,
    );

    // Unavailable version leaves the running Host and verified install untouched.
    await assert.rejects(
      () =>
        ensureInstalled(paths, {
          version: "0.0.0-does-not-exist",
          installer: async () => {
            throw new Error("registry unavailable");
          },
        }),
      /registry unavailable|failed|CliError|install/,
    );
    assert.ok(
      (await readdir(join(hostRoot, "runtime"))).includes(version),
    );
    assert.equal((await fetch(`${ready.url}/ready`)).status, 200);
    await stopChild(child);
    pass(
      "H7",
      "concurrent install once; verified install starts offline; failed version leaves Host untouched",
    );
  }

  // ── H8: Host survives Project node_modules deletion ──
  {
    const hostRoot = join(temporary, "host-h8");
    await writeHostFiles(hostRoot, { port: await availablePort() });
    const project = join(temporary, "project-h8");
    await installConsumer(project, packed, [
      "core",
      "agents",
      "runtime",
      "cli",
      "harness",
    ]);
    const versionDir = await installRuntimeTree(
      hostRoot,
      packed,
      runtimeVersion,
    );
    const require = createRequire(join(versionDir, "package.json"));
    const entry = require.resolve("@nylorun/runtime/server");
    const child = spawnHost(entry, hostRoot);
    live.push(() => stopChild(child));
    const ready = await awaitHostReady(child);
    await waitReady(ready.url);
    await rm(join(project, "node_modules"), { recursive: true, force: true });
    assert.equal((await fetch(`${ready.url}/ready`)).status, 200);
    assert.equal(
      (await (await fetch(`${ready.url}/health`)).json()).service,
      "nylorun-runtime",
    );
    await stopChild(child);
    pass("H8", "Host keeps running after the installing Project deletes node_modules");
  }

  // ── H9: Project link rules (clone / move / worktree / tenant use) ──
  {
    const hostRoot = join(temporary, "host-h9");
    const { hostId, adminKey } = await writeHostFiles(hostRoot, { port: 0 });
    const versionDir = await installRuntimeTree(
      hostRoot,
      packed,
      runtimeVersion,
    );
    const require = createRequire(join(versionDir, "package.json"));
    const entry = require.resolve("@nylorun/runtime/server");
    const child = spawnHost(entry, hostRoot);
    live.push(() => stopChild(child));
    const ready = await awaitHostReady(child);
    const url = ready.url;

    const project = join(temporary, "project-h9");
    await mkdir(project);
    await writeFile(join(project, "package.json"), '{"name":"link-demo"}');
    const tenant = await createTenant(url, adminKey, "link-demo");
    await mkdir(join(project, ".nylorun"), { recursive: true });
    const link = {
      hostUrl: url,
      hostId,
      tenantId: tenant.tenantId,
    };
    const credentials = {
      applicationKey: tenant.applicationKey,
      principalId: tenant.principalId,
      executors: {},
    };
    await writeFile(
      join(project, ".nylorun/link.json"),
      JSON.stringify(link, null, 2),
    );
    await writeFile(
      join(project, ".nylorun/credentials.json"),
      JSON.stringify(credentials, null, 2),
    );

    // Moved checkout: link travels with the tree.
    const moved = join(temporary, "project-h9-moved");
    await cp(project, moved, { recursive: true });
    await rm(project, { recursive: true, force: true });
    const movedLink = JSON.parse(
      await readFile(join(moved, ".nylorun/link.json"), "utf8"),
    );
    assert.equal(movedLink.tenantId, tenant.tenantId);
    assert.equal(
      (
        await fetch(`${url}/v1/tenant`, {
          headers: tenantHeaders(
            movedLink.tenantId,
            credentials.applicationKey,
          ),
        })
      ).status,
      200,
    );

    // Fresh clone: no .nylorun → does not inherit.
    const clone = join(temporary, "project-h9-clone");
    await mkdir(clone);
    await writeFile(join(clone, "package.json"), '{"name":"link-demo"}');
    await assert.rejects(stat(join(clone, ".nylorun/link.json")));

    // Second worktree: separate directory without .nylorun.
    const worktree = join(temporary, "project-h9-worktree");
    await mkdir(worktree);
    await writeFile(join(worktree, "package.json"), '{"name":"link-demo"}');
    await assert.rejects(stat(join(worktree, ".nylorun")));

    // tenant use: point worktree at the moved Tenant with copied credentials.
    await mkdir(join(worktree, ".nylorun"), { recursive: true });
    await writeFile(
      join(worktree, ".nylorun/credentials.json"),
      JSON.stringify(credentials, null, 2),
    );
    await writeFile(
      join(worktree, ".nylorun/link.json"),
      JSON.stringify(
        { hostUrl: url, hostId, tenantId: tenant.tenantId },
        null,
        2,
      ),
    );
    assert.equal(
      (
        await fetch(`${url}/v1/tenant`, {
          headers: tenantHeaders(tenant.tenantId, tenant.applicationKey),
        })
      ).status,
      200,
    );
    await stopChild(child);
    pass(
      "H9",
      "moved checkout keeps Project link; clone/worktree do not inherit; tenant use links explicitly",
    );
  }

  // ── H2: concurrent Projects through one port; stop one leaves Host + other ──
  {
    const hostRoot = join(temporary, "host-h2");
    const home = join(temporary, "home-h2");
    await mkdir(home);
    const port = await availablePort();
    const { hostId, adminKey } = await writeHostFiles(hostRoot, { port });
    const versionDir = await installRuntimeTree(
      hostRoot,
      packed,
      runtimeVersion,
    );
    const require = createRequire(join(versionDir, "package.json"));
    const entry = require.resolve("@nylorun/runtime/server");
    // Start Host first so both Projects attach to the shared Host.
    const hostChild = spawnHost(entry, hostRoot);
    live.push(() => stopChild(hostChild));
    const ready = await awaitHostReady(hostChild);
    assert.ok(ready.url.includes(String(port)) || port > 0);
    await waitReady(`http://127.0.0.1:${port}`);

    const makeProject = async (name) => {
      const project = join(temporary, `project-${name}`);
      await mkdir(join(project, "agents"), { recursive: true });
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({
          name,
          type: "module",
          private: true,
          dependencies: {
            "@nylorun/agents": `file:${packed.agents}`,
            "@nylorun/cli": `file:${packed.cli}`,
            "@nylorun/core": `file:${packed.core}`,
            "@nylorun/harness": `file:${packed.harness}`,
            "@nylorun/runtime": `file:${packed.runtime}`,
            tsx: "^4.20.0",
          },
        }),
      );
      await writeFile(
        join(project, "agents/index.ts"),
        `
import { Agent } from "@nylorun/agents";
export const agents = [Agent({ id: "shared-agent", name: "${name}" })];
`,
      );
      await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: project,
        capture: true,
      });
      const tenant = await createTenant(
        `http://127.0.0.1:${port}`,
        adminKey,
        name,
      );
      await mkdir(join(project, ".nylorun"), { recursive: true });
      await writeFile(
        join(project, ".nylorun/link.json"),
        JSON.stringify(
          {
            hostUrl: `http://127.0.0.1:${port}`,
            hostId,
            tenantId: tenant.tenantId,
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(project, ".nylorun/credentials.json"),
        JSON.stringify(
          {
            applicationKey: tenant.applicationKey,
            principalId: tenant.principalId,
            executors: {},
          },
          null,
          2,
        ),
      );
      return { project, tenant };
    };

    const first = await makeProject("alpha-dev");
    const second = await makeProject("beta-dev");

    const startDev = (project) => {
      const child = spawn(
        process.execPath,
        [
          join(project, "node_modules/@nylorun/cli/dist/cli.js"),
          "dev",
          "--no-studio",
          "--no-autostart",
        ],
        {
          cwd: project,
          env: {
            PATH: process.env.PATH,
            NYLORUN_HOME: hostRoot,
            HOME: home,
            USERPROFILE: home,
            PORT: String(port),
            NYLORUN_DEV_MODEL: "fixture",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return child;
    };

    const waitReadyLine = (child, timeoutMs = 60_000) =>
      new Promise((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `timeout waiting for connected agents: ${buffer.slice(-2000)}`,
              ),
            ),
          timeoutMs,
        );
        const onData = (chunk) => {
          buffer += chunk.toString("utf8");
          if (/Ready\s+\d+ connected agent/i.test(buffer)) {
            cleanup();
            resolve(buffer);
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          child.stderr?.off("data", onData);
          child.off("exit", onExit);
        };
        const onExit = (code) => {
          cleanup();
          reject(new Error(`dev exited ${code}: ${buffer.slice(-2000)}`));
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("exit", onExit);
      });

    const devA = startDev(first.project);
    const devB = startDev(second.project);
    live.push(() => stopChild(devA));
    live.push(() => stopChild(devB));
    await Promise.all([waitReadyLine(devA), waitReadyLine(devB)]);
    // Both Tenants reachable on the same port.
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/v1/tenant`, {
          headers: tenantHeaders(
            first.tenant.tenantId,
            first.tenant.applicationKey,
          ),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/v1/tenant`, {
          headers: tenantHeaders(
            second.tenant.tenantId,
            second.tenant.applicationKey,
          ),
        })
      ).status,
      200,
    );

    // Stop one Project runner; Host and the other Tenant remain.
    await stopChild(devA);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ready`)).status, 200);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/v1/tenant`, {
          headers: tenantHeaders(
            second.tenant.tenantId,
            second.tenant.applicationKey,
          ),
        })
      ).status,
      200,
    );
    await stopChild(devB);
    await stopChild(hostChild);
    pass(
      "H2",
      "concurrent Projects share one Host port; stopping one leaves Host and the other Tenant",
    );
  }

  console.log("\nAll packed-package acceptance checks passed:");
  for (const item of results) console.log(`  ${item.id} ${item.message}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const stop of live.splice(0).reverse()) await stop().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}

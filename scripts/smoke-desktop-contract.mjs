/**
 * Desktop contract smoke (WS-J / D18): Babai's D§15 flow headlessly.
 *
 * Bootstrap is implemented here independently of the CLI (as a desktop client
 * would), against a local registry + Runtime build. J5 CI matrix wiring is
 * owned by WS-G (Wave 3).
 *
 * Usage:
 *   node scripts/smoke-desktop-contract.mjs
 *   node --test scripts/test/desktop-contract.test.mjs
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { lstatSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Agent, connectAgents, createClient, RuntimeError } from "@nylorun/agents";
import { createAdmin, AdminError } from "@nylorun/admin";
import { compareVersions } from "@nylorun/core/compatibility";
import {
  currentPlatformArch,
  defaultBuildOut,
  localRuntimeBuild,
} from "./lib/local-build.mjs";
import { startLocalRegistry } from "./lib/local-registry.mjs";
import { readJson, root } from "./lib/repo.mjs";

const DOWNLOAD_PREFIX = ".download-";

function encodeScopedName(name) {
  if (!name.startsWith("@")) return encodeURIComponent(name);
  const slash = name.indexOf("/");
  return `${name.slice(0, slash)}%2f${name.slice(slash + 1)}`;
}

function launcherBinName(platform = process.platform) {
  return platform === "win32" ? "nylorun-runtime.cmd" : "nylorun-runtime";
}

async function integrityOfFile(path) {
  return `sha512-${createHash("sha512")
    .update(await readFile(path))
    .digest("base64")}`;
}

async function extractTarball(tarballPath, dest) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-xzf", tarballPath, "-C", dest, "--strip-components=1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `tar extraction failed (${code})${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
    });
  });
}

/**
 * Resolve the newest installed Runtime build under home (D§9.1).
 * Independent of CLI / launcher source — Babai-shaped.
 */
export async function resolveNewestLauncher(home, platform, arch) {
  const runtimeRoot = join(home, "runtime");
  let names;
  try {
    names = await readdir(runtimeRoot);
  } catch {
    return undefined;
  }
  /** @type {Array<{ version: string, launcher: string, path: string }>} */
  const builds = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = join(runtimeRoot, name);
    let manifest;
    try {
      manifest = await readJson(join(dir, "manifest.json"));
    } catch {
      continue;
    }
    if (
      manifest?.platform !== platform ||
      manifest?.arch !== arch ||
      typeof manifest.runtimeVersion !== "string"
    ) {
      continue;
    }
    const launcher = join(dir, "bin", launcherBinName(platform));
    try {
      await access(launcher);
    } catch {
      continue;
    }
    builds.push({
      version: manifest.runtimeVersion,
      launcher,
      path: dir,
    });
  }
  if (builds.length === 0) return undefined;
  builds.sort((a, b) => compareVersions(a.version, b.version));
  return builds[builds.length - 1];
}

/**
 * Desktop bootstrap (D§10): fetch → download → verify → extract → install
 * --from → always delete staging. Writes nothing else under home.
 */
export async function bootstrapDesktop({
  home,
  version,
  registry,
  packageName,
  platform = process.platform,
  arch = process.arch,
}) {
  const runtimeRoot = join(home, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const staging = join(
    runtimeRoot,
    `${DOWNLOAD_PREFIX}${randomBytes(6).toString("hex")}`,
  );
  await mkdir(staging, { recursive: true });
  try {
    const encoded = encodeScopedName(packageName);
    const meta = await fetch(`${registry}/${encoded}/${version}`).then(
      async (response) => {
        if (!response.ok) {
          throw new Error(
            `Registry metadata ${response.status} for ${packageName}@${version}`,
          );
        }
        return response.json();
      },
    );
    const tarballUrl = meta?.dist?.tarball;
    const integrity = meta?.dist?.integrity;
    if (typeof tarballUrl !== "string" || typeof integrity !== "string") {
      throw new Error(
        `Registry metadata for ${packageName}@${version} missing dist.tarball/integrity`,
      );
    }

    const tarballPath = join(staging, "package.tgz");
    const bytes = Buffer.from(
      await fetch(tarballUrl).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Tarball download failed: HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      }),
    );
    await writeFile(tarballPath, bytes);
    const actual = await integrityOfFile(tarballPath);
    if (actual !== integrity) {
      throw new Error(
        `integrity_mismatch: expected ${integrity}, got ${actual}`,
      );
    }
    await extractTarball(tarballPath, staging);
    await rm(tarballPath, { force: true });
    // npm pack can drop absolute Node symlinks; ensure node.exe|node exists
    // before invoking the extracted launcher on Windows runners.
    await materializeNodeBinary(staging, platform);

    const extractedLauncher = join(staging, "bin", launcherBinName(platform));
    await access(extractedLauncher);
    const install = await runLauncherProcess(extractedLauncher, home, [
      "install",
      version,
      "--from",
      staging,
    ], { NYLORUN_REGISTRY: registry });
    if (install.error) {
      throw new Error(
        `bootstrap install failed: ${install.error.code}: ${install.error.message}`,
      );
    }
    if (install.exitCode !== 0 || !install.result) {
      throw new Error(
        `bootstrap install failed (exit ${install.exitCode}): ${install.stderr || install.stdout || "no result event"}`,
      );
    }
    return install.result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Install a local build directory into home via that build's own launcher. */
async function installFromBuildDir(home, build, registryUrl) {
  const launcher = join(build.dir, "bin", launcherBinName());
  const result = await runLauncherProcess(
    launcher,
    home,
    ["install", build.version, "--from", build.dir],
    { NYLORUN_REGISTRY: registryUrl },
  );
  if (result.error || result.exitCode !== 0) {
    throw new Error(
      `install --from failed: ${result.error?.code ?? result.exitCode}: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.result;
}

/**
 * Run nylorun-runtime with --json; return { result, error, events, exitCode }.
 */
export async function runLauncherProcess(launcherPath, home, args, extraEnv = {}) {
  const env = {
    ...process.env,
    NYLORUN_HOME: home,
    ...extraEnv,
  };
  // Node on Windows rejects spawning `.cmd` without a shell (EINVAL /
  // CVE-2024-27980). Prefer the build's node.exe + launcher entry so stdout
  // stays clean NDJSON (shell:true wraps/scrubs output on runners).
  let command = launcherPath;
  let argv = ["--home", home, "--json", ...args];
  if (process.platform === "win32" && /\.cmd$/i.test(launcherPath)) {
    const buildRoot = resolve(dirname(launcherPath), "..");
    const nodeExe = join(buildRoot, "node", "bin", "node.exe");
    const entry = join(
      buildRoot,
      "lib",
      "node_modules",
      "@nylorun",
      "runtime",
      "dist",
      "launcher",
      "main.js",
    );
    try {
      await access(nodeExe);
      await access(entry);
      command = nodeExe;
      argv = [entry, ...argv];
    } catch {
      // Fall back to cmd.exe /c for non-standard layouts (e.g. fixtures).
      command = process.env.ComSpec ?? "cmd.exe";
      argv = [
        "/d",
        "/s",
        "/c",
        `"${launcherPath}" --home "${home}" --json ${args.map((a) => `"${a}"`).join(" ")}`,
      ];
    }
  }
  const child = spawn(command, argv, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
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

export async function runLauncher(home, args, { registry, platform, arch } = {}) {
  const current = currentPlatformArch(
    platform ?? process.platform,
    arch ?? process.arch,
  );
  const newest = await resolveNewestLauncher(home, current.platform, current.arch);
  if (!newest) {
    throw new Error(
      `No Runtime launcher installed under ${home}; bootstrap first.`,
    );
  }
  const extraEnv = registry ? { NYLORUN_REGISTRY: registry } : {};
  return runLauncherProcess(newest.launcher, home, args, extraEnv);
}

/**
 * Local builds symlink Node for speed; npm pack omits absolute symlinks, so a
 * registry tarball would lack node/bin/node. Replace with a real copy so
 * bootstrap (D§10) can run the extracted launcher. Change request for WS-G:
 * local-build should copy (or pack a materialized) Node in local mode.
 */
async function materializeNodeBinary(buildDir, platform = process.platform) {
  const binDir = join(buildDir, "node", "bin");
  const target = join(binDir, platform === "win32" ? "node.exe" : "node");
  try {
    const stats = lstatSync(target);
    if (!stats.isSymbolicLink()) {
      await access(target);
      return target;
    }
  } catch {
    /* missing — copy below */
  }
  await mkdir(binDir, { recursive: true });
  await rm(target, { force: true });
  await copyFile(process.execPath, target);
  if (platform !== "win32") await chmod(target, 0o755);
  return target;
}

/**
 * Ensure a D§8.2 local Runtime build exists (reuse .tmp when present).
 */
export async function ensureLocalBuild({ force = false } = {}) {
  const { platform, arch } = currentPlatformArch();
  const out = defaultBuildOut(platform, arch, root);
  const marker = join(out, "bin", launcherBinName(platform));
  if (!force) {
    try {
      await access(marker);
      await access(join(out, "manifest.json"));
      const pkg = await readJson(join(out, "package.json"));
      const runtime = await readJson(join(root, "runtime/package.json"));
      if (pkg.version === runtime.version && pkg.name === `@nylorun/runtime-${platform}-${arch}`) {
        await materializeNodeBinary(out, platform);
        return { dir: out, name: pkg.name, version: pkg.version };
      }
    } catch {
      /* build */
    }
  }
  await access(join(root, "runtime/dist/host/main.js"));
  const built = await localRuntimeBuild({ out, repo: root });
  await materializeNodeBinary(built.dir, platform);
  return built;
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
export async function runHappyPath({
  home,
  registry,
  build,
  log = () => {},
}) {
  const { platform, arch } = currentPlatformArch();
  assert.equal(
    await resolveNewestLauncher(home, platform, arch),
    undefined,
    "J1 expects a fresh home with no installed build",
  );

  log("J1: bootstrap");
  const installed = await bootstrapDesktop({
    home,
    version: build.version,
    registry: registry.url,
    packageName: build.name,
    platform,
    arch,
  });
  assert.equal(installed.version, build.version);
  assert.equal(installed.installed, true);

  const leftovers = (await readdir(join(home, "runtime"))).filter((n) =>
    n.startsWith(DOWNLOAD_PREFIX),
  );
  assert.deepEqual(leftovers, [], "bootstrap must remove .download-* staging");

  log("J1: up --version");
  const up1 = await runLauncher(home, ["up", "--version", build.version, "--port", "0"], {
    registry: registry.url,
  });
  assert.equal(up1.exitCode, 0, up1.stderr || JSON.stringify(up1.error));
  assert.equal(up1.result?.started, true);
  assert.match(up1.result.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(up1.result.version, build.version);

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
  const up2 = await runLauncher(home, ["up", "--version", build.version], {
    registry: registry.url,
  });
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
export async function runHostSchemaNewerCase({
  registry,
  build,
  log = () => {},
}) {
  const home = await mkdtemp(join(tmpdir(), "nylorun-desktop-schema-"));
  try {
    await installFromBuildDir(home, build, registry.url);
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
    const up = await runLauncher(
      home,
      ["up", "--version", build.version, "--port", "0"],
      { registry: registry.url },
    );
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
export async function runForeignPortCase({
  registry,
  build,
  log = () => {},
}) {
  const home = await mkdtemp(join(tmpdir(), "nylorun-desktop-foreign-"));
  const foreign = createServer((_req, res) => {
    res.writeHead(200);
    res.end("not-nylorun");
  });
  try {
    await installFromBuildDir(home, build, registry.url);
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
      ["up", "--version", build.version, "--port", String(foreignPort)],
      { registry: registry.url },
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
 * Full J1–J4 desktop contract against a temporary home + local registry.
 */
export async function runDesktopContractSmoke({
  log = console.log,
  keepHome = false,
} = {}) {
  const build = await ensureLocalBuild();
  log(`Using Runtime build ${build.name}@${build.version} at ${build.dir}`);

  const registry = await startLocalRegistry({
    builds: [{ name: build.name, version: build.version, dir: build.dir }],
  });
  const home = await mkdtemp(join(tmpdir(), "nylorun-desktop-home-"));
  let happy;
  try {
    log(`NYLORUN_HOME=${home}`);
    log(`NYLORUN_REGISTRY=${registry.url}`);

    happy = await runHappyPath({ home, registry, build, log });

    log("J3: deleted Tenant");
    await runDeletedTenantCase({
      admin: happy.admin,
      client: happy.client,
      stored: happy.stored,
    });

    log("J3: incompatible_host");
    await runIncompatibleHostCase();

    log("J3: host_schema_newer");
    await runHostSchemaNewerCase({ registry, build, log });

    log("J3: foreign_port");
    await runForeignPortCase({ registry, build, log });

    log("J4: Origin rejected");
    await runOriginRejectedCase(happy.up.url);

    log("J1: down");
    const down = await runLauncher(home, ["down", "--force"], {
      registry: registry.url,
    });
    assert.equal(down.exitCode, 0, down.stderr || JSON.stringify(down.error));
    assert.equal(down.result?.stopped, true);

    log("Desktop contract smoke passed (J1–J4).");
    return { home, build, registryUrl: registry.url };
  } finally {
    if (happy?.up) {
      try {
        await runLauncher(home, ["down", "--force"], {
          registry: registry.url,
        });
      } catch {
        /* best-effort */
      }
      await wait(200);
    }
    await registry.close();
    if (!keepHome) await rm(home, { recursive: true, force: true });
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

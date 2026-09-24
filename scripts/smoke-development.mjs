/**
 * G7 development smoke: packed create-agent starter against a local-registry
 * Runtime build — `npm run dev`, separate `nylorun-studio`, then
 * `npm run build` + `npm start` (`node dist/src/main.js`) with Project link env.
 * No `nylorun serve`.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  localRuntimeBuild,
  materializeNodeBinary,
} from "./lib/local-build.mjs";
import { startLocalRegistry } from "./lib/local-registry.mjs";
import { ProcessGroup } from "./lib/processes.mjs";
import { npmCli, root, run } from "./lib/repo.mjs";

const temporary = await mkdtemp(join(tmpdir(), "nylorun-dev-smoke-"));
const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-dev-host-"));
const home = await mkdtemp(join(tmpdir(), "nylorun-dev-home-"));
const group = new ProcessGroup();
let registry;

const readyLine = (l) =>
  l.includes("Ready") || l.includes("Ctrl-C stops this Project only");
const hostLine = (l) => /^\s*Host\s+http/.test(l);
const studioOnLine = (l) => /^Studio on http/.test(l);

try {
  const built = await localRuntimeBuild({
    out: join(root, ".tmp/runtime-builds"),
    repo: root,
  });
  await materializeNodeBinary(built.dir);
  registry = await startLocalRegistry({ builds: [built] });

  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts);
  const names = [
    "core",
    "harness",
    "agents",
    "admin",
    "runtime",
    "studio",
    "cli",
    "create-agent",
  ];
  const tarballs = {};
  for (const name of names) {
    const packed = JSON.parse(
      await run(
        process.execPath,
        [
          npmCli(),
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          artifacts,
        ],
        { cwd: join(root, name), capture: true },
      ),
    );
    tarballs[name] = join(artifacts, packed[0].filename);
  }

  const creator = join(temporary, "creator");
  await mkdir(creator);
  await run("tar", ["-xzf", tarballs["create-agent"], "-C", creator]);
  const { starterFiles } = await import(
    pathToFileURL(join(creator, "package/dist/scaffold.js")).href
  );
  const pins = JSON.parse(
    await readFile(join(creator, "package/compatibility.json"), "utf8"),
  );

  const project = join(temporary, "app");
  await mkdir(project);
  const files = await starterFiles(pins, true);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), content);
  }
  const manifest = JSON.parse(files["package.json"]);
  assert.equal(manifest.scripts.dev, "nylorun dev");
  assert.equal(manifest.scripts.studio, "nylorun-studio");
  assert.equal(manifest.scripts.start, "node dist/src/main.js");
  assert.ok(!JSON.stringify(manifest.scripts).includes("serve"));

  manifest.dependencies["@nylorun/agents"] = `file:${tarballs.agents}`;
  manifest.dependencies["@nylorun/core"] = `file:${tarballs.core}`;
  manifest.devDependencies ??= {};
  manifest.devDependencies["@nylorun/cli"] = `file:${tarballs.cli}`;
  manifest.devDependencies["@nylorun/admin"] = `file:${tarballs.admin}`;
  manifest.devDependencies["@nylorun/studio"] = `file:${tarballs.studio}`;
  await writeFile(
    join(project, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  await run(
    process.execPath,
    [npmCli(), "install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: project },
  );

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NYLORUN_HOME: hostRoot,
    NYLORUN_REGISTRY: registry.url,
    NYLORUN_DEV_MODEL: "fixture",
  };

  const studioBin = join(project, "node_modules/@nylorun/studio/dist/cli.js");
  const cliBin = join(project, "node_modules/@nylorun/cli/dist/cli.js");

  const dev = group.start(
    "dev",
    process.execPath,
    [cliBin, "dev", "--ephemeral"],
    { cwd: project, env },
  );
  await dev.line(hostLine, 120_000);
  await dev.line(readyLine, 90_000);
  const studio = group.start(
    "studio",
    process.execPath,
    [studioBin, "--no-open"],
    { cwd: project, env },
  );
  const studioBanner = await studio.line(studioOnLine, 90_000);
  const studioUrl = studioBanner.replace(/^Studio on\s+/, "").trim();
  assert.match(await (await fetch(studioUrl)).text(), /<div id="root">/);
  await studio.stop();
  await dev.stop();

  await rm(join(project, ".nylorun"), { recursive: true, force: true }).catch(
    () => {},
  );
  const up = group.start(
    "runtime-up",
    process.execPath,
    [cliBin, "runtime", "up"],
    { cwd: project, env },
  );
  assert.equal(await up.exit, 0, "runtime up must succeed");

  const attach = group.start(
    "dev-attach",
    process.execPath,
    [cliBin, "dev"],
    { cwd: project, env },
  );
  await attach.line(readyLine, 120_000);
  await attach.stop();

  await run(process.execPath, [npmCli(), "run", "build"], { cwd: project });

  const link = JSON.parse(
    await readFile(join(project, ".nylorun/link.json"), "utf8"),
  );
  const credentials = JSON.parse(
    await readFile(join(project, ".nylorun/credentials.json"), "utf8"),
  );
  const startEnv = {
    ...env,
    NYLORUN_RUNTIME_URL: link.hostUrl,
    NYLORUN_TENANT: link.tenantId,
    NYLORUN_SERVER_KEY: credentials.applicationKey,
  };
  const started = group.start(
    "start",
    process.execPath,
    [npmCli(), "start"],
    { cwd: project, env: startEnv },
  );
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(
    await fetch(`${link.hostUrl}/ready`).then((r) => r.ok),
    true,
    "Host still ready while npm start runs",
  );
  await started.stop();

  await run(
    process.execPath,
    [cliBin, "runtime", "down", "--force"],
    { cwd: project, env },
  );

  console.log(
    "Development smoke passed: starter via local-registry build, nylorun dev, nylorun-studio, npm start (node dist/src/main.js), no serve.",
  );
} finally {
  await group.close();
  await registry?.close?.();
  await rm(temporary, { recursive: true, force: true });
  await rm(hostRoot, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}

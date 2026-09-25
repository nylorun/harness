/**
 * I2 developer flow (manager gate G2):
 * create-agent from local tarballs → `npm run dev` → `npm run studio` (both
 * orders) → `npm run build && npm start` with the three link variables.
 * Production deps of the generated app must be only `@nylorun/agents` (+ core).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { root, npmCli, run } from "./lib/repo.mjs";
import { ProcessGroup } from "./lib/processes.mjs";
import { installRuntime } from "./lib/runtime-install.mjs";

const temporary = await mkdtemp(join(tmpdir(), "nylorun-i2-"));
const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-i2-host-"));
const home = await mkdtemp(join(tmpdir(), "nylorun-i2-home-"));
const group = new ProcessGroup();

const readyLine = (l) =>
  l.includes("Ready") || l.includes("Ctrl-C stops this Project only");
const hostLine = (l) => /^\s*Host\s+http/.test(l);
const studioOnLine = (l) => /^Studio on http/.test(l);
const waitingLine = (l) => l.includes("Waiting for nylorun dev");

try {
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

  const ls = await run(
    process.execPath,
    [npmCli(), "ls", "--omit=dev", "--all", "--json"],
    { cwd: project, capture: true },
  );
  const tree = JSON.parse(ls);
  const nylorun = [];
  const walk = (node, name = node.name) => {
    if (typeof name === "string" && name.startsWith("@nylorun/"))
      nylorun.push(name);
    for (const [childName, child] of Object.entries(node.dependencies ?? {}))
      walk(child, childName);
  };
  walk(tree);
  const unique = [...new Set(nylorun)].sort();
  assert.deepEqual(
    unique,
    ["@nylorun/agents", "@nylorun/core"].sort(),
    `production Nylorun deps must be agents+core; got ${unique.join(", ")}`,
  );

  // Prerequisite, as a developer does: the Runtime on PATH (packed candidate).
  const runtime = await installRuntime(join(temporary, "runtime"), [
    tarballs.runtime,
    tarballs.core,
    tarballs.harness,
  ]);
  const env = runtime.env({
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NYLORUN_HOME: hostRoot,
    NYLORUN_DEV_MODEL: "fixture",
  });

  // Order A: dev first, then studio (invoke Studio CLI directly — npm's
  // lifecycle + ProcessGroup detached spawn can exit before the bin attaches).
  const studioBin = join(project, "node_modules/@nylorun/studio/dist/cli.js");
  const cliBin = join(project, "node_modules/@nylorun/cli/dist/cli.js");
  const devA = group.start(
    "dev-a",
    process.execPath,
    [cliBin, "dev", "--ephemeral"],
    { cwd: project, env },
  );
  await devA.line(hostLine, 120_000);
  await devA.line(readyLine, 90_000);
  const studioA = group.start(
    "studio-a",
    process.execPath,
    [studioBin, "--no-open"],
    { cwd: project, env },
  );
  await studioA.line(studioOnLine, 90_000);
  await studioA.stop();
  await devA.stop();

  // Order B: studio first (waits), then dev attaches the Project link.
  await rm(join(project, ".nylorun"), { recursive: true, force: true }).catch(
    () => {},
  );
  const studioB = group.start(
    "studio-b",
    process.execPath,
    [studioBin, "--no-open"],
    { cwd: project, env },
  );
  await studioB.line(waitingLine, 30_000);
  const devB = group.start(
    "dev-b",
    process.execPath,
    [cliBin, "dev", "--ephemeral"],
    { cwd: project, env },
  );
  await devB.line(readyLine, 120_000);
  await studioB.line(studioOnLine, 90_000);
  await studioB.stop();
  await devB.stop();

  // Persistent Host for build + start (three env variables).
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
    [join(project, "dist/src/main.js")],
    { cwd: project, env: startEnv },
  );
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(
    await fetch(`${link.hostUrl}/ready`).then((r) => r.ok),
    true,
    "Host still ready while start runs",
  );
  await started.stop();

  await run(
    process.execPath,
    [cliBin, "runtime", "down", "--force"],
    { cwd: project, env },
  );

  console.log(
    "PASS: I2 developer flow (tarballs, npm ls, dev↔studio both orders, build+start).",
  );
} finally {
  await group.close();
  await rm(temporary, { recursive: true, force: true });
  await rm(hostRoot, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}

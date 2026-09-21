import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, npm, run } from "./lib/repo.mjs";
const temporary = await mkdtemp(join(tmpdir(), "nylorun-isolated-"));
try {
  const packed = {};
  for (const name of ["core", "harness", "agents", "runtime"]) {
    const result = JSON.parse(
      await npm(
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
        { cwd: join(root, name), capture: true }
      )
    );
    packed[name] = join(temporary, result[0].filename);
  }
  for (const [name, deps, forbidden] of [
    ["sdk", ["core", "agents"], ["harness", "runtime", "cli"]],
    ["host", ["core", "harness", "runtime"], ["agents", "cli", "studio"]],
  ]) {
    const cwd = join(temporary, name);
    await mkdir(cwd);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ private: true, type: "module" })
    );
    await npm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...deps.map((dep) => packed[dep]),
      ],
      { cwd, capture: true }
    );
    for (const dependency of forbidden)
      await assert.rejects(
        access(join(cwd, "node_modules/@nylorun", dependency))
      );
    const source =
      name === "sdk"
        ? `
      import assert from 'node:assert/strict';
      import { Agent } from '@nylorun/agents/define';
      import { createClient } from '@nylorun/agents/client';
      import { connectAgents } from '@nylorun/agents/executor';
      assert.equal(Agent({id:'isolated',name:'Isolated'}).manifest.id, 'isolated');
      assert.equal(typeof createClient, 'function');
      assert.equal(typeof connectAgents, 'function');
    `
        : `
      import assert from 'node:assert/strict';
      import { fork } from 'node:child_process';
      import { createRequire } from 'node:module';
      const child = fork(createRequire(import.meta.url).resolve('@nylorun/runtime/server'), [], {
        env: {...process.env, PORT:'0', NYLORUN_SERVER_KEY:'isolated-server-secret', NYLORUN_DEV_MODEL:'fixture', NYLORUN_EXECUTORS_JSON:'[]', NYLORUN_SQLITE_PATH:'./isolated.sqlite'},
        stdio:['ignore','ignore','inherit','ipc']
      });
      try {
        const ready = await new Promise((resolve,reject) => {
          const timer=setTimeout(()=>reject(new Error('Isolated runtime readiness timeout')),20000);
          child.once('message',message=>{clearTimeout(timer);resolve(message)});
          child.once('error',error=>{clearTimeout(timer);reject(error)});
          child.once('exit',code=>{clearTimeout(timer);reject(new Error('Runtime exited '+code))});
        });
        assert.equal(ready.type,'ready');
        assert.equal((await fetch(ready.url+'/ready')).status,200);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const closed=new Promise(resolve=>child.once('exit',resolve));
          child.kill('SIGTERM');
          await closed;
        }
      }
    `;
    await writeFile(join(cwd, "check.mjs"), source);
    await run(process.execPath, ["check.mjs"], {
      cwd,
      capture: true,
      timeout: 30000,
    });
    console.log(
      `Isolated ${name} tarball installation passed without ${forbidden.join(
        ", "
      )}.`
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

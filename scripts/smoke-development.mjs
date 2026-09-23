import assert from "node:assert/strict";
import { mkdtemp, rm, cp, symlink, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { root } from "./lib/repo.mjs";
import { availablePort, develop } from "./lib/development.mjs";

async function stopRuntime(project) {
  await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(root, "cli/dist/cli.js"), "down"],
      { cwd: project, stdio: "ignore" },
    );
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  try {
    const pid = Number(await readFile(join(project, ".nylorun/runtime.pid"), "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    /* already stopped */
  }
}

// Exercise the repository supervisor without reading or changing developer credentials/data.
const temporary = await mkdtemp(join(tmpdir(), "nylorun-root-smoke-"));
let app;
try {
  await cp(
    join(root, "examples/package.json"),
    join(temporary, "package.json"),
  );
  await mkdir(join(temporary, "agents"));
  await cp(
    join(root, "examples/agents/release"),
    join(temporary, "agents/release"),
    { recursive: true },
  );
  await writeFile(
    join(temporary, "agents/index.ts"),
    'export { agents } from "./release/index.js";\n',
  );
  await symlink(
    join(root, "examples/node_modules"),
    join(temporary, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const port = await availablePort();
  let studioPort = await availablePort();
  while (studioPort === port) studioPort = await availablePort();
  process.env.NYLORUN_DEV_MODEL = "fixture";
  app = await develop(
    { studio: true, open: false, port, studioPort },
    { project: temporary, built: true },
  );
  const url = `http://127.0.0.1:${studioPort}`;
  assert.deepEqual(
    await (await fetch(`${url}/nylo-studio.config.json`)).json(),
    { runtimeUrl: "/_studio/runtime", local: true },
  );
  assert.match(await (await fetch(url)).text(), /<div id="root">/);
  const agents = await (await fetch(`${url}/_studio/runtime/v1/agents`)).json();
  assert.equal(agents.agents.length, 1);
  // IPv4 and localhost are both valid same-origin entry points.
  const session = await fetch(
    `${url}/_studio/runtime/v1/sessions/smoke-local`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ requestId: crypto.randomUUID(), agentId: "assistant", ownerUserId: "ignored" }),
    },
  );
  assert.ok(session.ok, await session.text());
  await app.close();
  // Persistent Runtime outlives `nylorun dev` (dx-improvements); stop it for this disposable project.
  await stopRuntime(temporary);
  await availablePort(port);
  await availablePort(studioPort);
  console.log(
    "Development smoke passed: real Runtime, supported agent, Studio session proxy, packaged frontend, and shutdown.",
  );
} finally {
  await app?.close();
  await stopRuntime(temporary);
  await rm(temporary, { recursive: true, force: true });
}

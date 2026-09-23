import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, cp, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./lib/repo.mjs";
import { availablePort, develop } from "./lib/development.mjs";

/**
 * Persistent Runtime answers /ready before the project runner finishes
 * registering agents. Poll Studio's proxied list until one appears.
 */
async function waitForAgents(studioUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${studioUrl}/_studio/runtime/v1/agents`);
      if (response.ok) {
        const body = await response.json();
        if (Array.isArray(body.agents) && body.agents.length > 0) return body;
        last = `agents=${JSON.stringify(body.agents ?? null)}`;
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for agents (${last}).`);
}

/** Stop the project-scoped Runtime daemon left up by `nylorun dev`. */
async function stopRuntime(project) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "cli/dist/cli.js"), "down"],
      { cwd: project, stdio: "ignore" }
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 || code === 6
        ? resolve()
        : reject(new Error(`nylorun down exited ${code}`))
    );
  });
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
  const agents = await waitForAgents(url);
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
  // Persistent Runtime outlives `nylorun dev`; stop it before port checks.
  await stopRuntime(temporary);
  await availablePort(port);
  await availablePort(studioPort);
  console.log(
    "Development smoke passed: real Runtime, supported agent, Studio session proxy, packaged frontend, and shutdown.",
  );
} finally {
  await app?.close();
  try {
    await stopRuntime(temporary);
  } catch {
    /* best-effort cleanup */
  }
  await rm(temporary, { recursive: true, force: true });
}

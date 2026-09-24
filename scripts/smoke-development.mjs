import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, cp, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./lib/repo.mjs";
import { availablePort, develop } from "./lib/development.mjs";

/**
 * Persistent Runtime answers /ready before the project runner finishes
 * registering agents. Poll Studio's proxied list until `min` agents appear
 * (not merely the first) so multi-agent projects do not race the assertion.
 */
async function waitForAgents(studioUrl, min = 1, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${studioUrl}/_studio/runtime/v1/agents`);
      if (response.ok) {
        const body = await response.json();
        if (Array.isArray(body.agents) && body.agents.length >= min) return body;
        last = `agents=${JSON.stringify(body.agents ?? null)}`;
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${min} agent(s) (${last}).`);
}

/** Stop the Host left up by `nylorun dev` under the temporary Host root. */
async function stopRuntime(project, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "cli/dist/cli.js"), "runtime", "down"],
      { cwd: project, stdio: "ignore", env },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 || code === 6
        ? resolve()
        : reject(new Error(`nylorun runtime down exited ${code}`)),
    );
  });
}

// Exercise the repository supervisor without reading or changing developer Host data.
const temporary = await mkdtemp(join(tmpdir(), "nylorun-root-smoke-"));
const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-host-smoke-"));
const home = await mkdtemp(join(tmpdir(), "nylorun-home-smoke-"));
const hostEnv = {
  ...process.env,
  NYLORUN_HOME: hostRoot,
  HOME: home,
  USERPROFILE: home,
  NYLORUN_DEV_MODEL: "fixture",
};
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
    { project: temporary, built: true, hostRoot, home },
  );
  const url = `http://127.0.0.1:${studioPort}`;
  const config = await (await fetch(`${url}/nylo-studio.config.json`)).json();
  assert.equal(config.runtimeUrl, "/_studio/runtime");
  assert.equal(config.local, true);
  assert.match(config.tenant?.id ?? "", /^tn_/);
  assert.match(await (await fetch(url)).text(), /<div id="root">/);
  // release/ ships assistant + sandbox analyst; wait for both, not the first.
  const agents = await waitForAgents(url, 2);
  assert.equal(agents.agents.length, 2);
  // IPv4 and localhost are both valid same-origin entry points.
  const session = await fetch(
    `${url}/_studio/runtime/v1/sessions/smoke-local`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        agentId: "assistant",
        ownerUserId: "ignored",
      }),
    },
  );
  assert.ok(session.ok, await session.text());
  await app.close();
  // Persistent Host outlives `nylorun dev`; stop it before port checks.
  await stopRuntime(temporary, hostEnv);
  await availablePort(port);
  await availablePort(studioPort);
  console.log(
    "Development smoke passed: shared Host under temporary NYLORUN_HOME, Studio session proxy, packaged frontend, and shutdown.",
  );
} finally {
  await app?.close();
  await stopRuntime(temporary, hostEnv).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
  await rm(hostRoot, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}

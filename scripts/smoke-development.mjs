import assert from "node:assert/strict";
import { ProcessGroup } from "./lib/processes.mjs";
import { root, npmCli } from "./lib/repo.mjs";
import { availablePort } from "./lib/development.mjs";

const group = new ProcessGroup();
try {
  const port = await availablePort();
  let studioPort = await availablePort();
  while (studioPort === port) studioPort = await availablePort();
  const child = group.start(
    "root-dev",
    process.execPath,
    [
      npmCli(),
      "run",
      "dev",
      "--",
      "--no-open",
      "--port",
      String(port),
      "--studio-port",
      String(studioPort),
    ],
    { cwd: root },
  );
  const url = `http://127.0.0.1:${studioPort}`;
  await child.ready(`${url}/nylo-studio.config.json`, 90_000);
  assert.deepEqual(
    await (await fetch(`${url}/nylo-studio.config.json`)).json(),
    { agentServerUrl: `http://127.0.0.1:${port}/agents` },
  );
  assert.match(await (await fetch(url)).text(), /@vite\/client/);
  const agents = await (
    await fetch(`http://127.0.0.1:${port}/agents/v1/agents`)
  ).json();
  assert.equal(agents.agents.length, 11);
  await child.stop();
  await availablePort(port);
  await availablePort(studioPort);
  console.log(
    "Development smoke passed: real Runtime, eleven agents, Studio configuration proxy, Vite frontend, and shutdown.",
  );
} finally {
  await group.close();
}

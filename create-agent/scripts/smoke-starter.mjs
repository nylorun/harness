import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  access,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { root, npmCli, run } from "../../scripts/lib/repo.mjs";
import { ProcessGroup } from "../../scripts/lib/processes.mjs";
import { availablePort } from "../../scripts/lib/development.mjs";

// Run after building all packages. --serve retains Studio for manual browser verification.
const keepServing = process.argv.includes("--serve");
await mkdir(join(root, ".tmp"), { recursive: true });
const temporary = await mkdtemp(join(root, ".tmp/starter-smoke-"));
const group = new ProcessGroup();
try {
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts);
  const tarballs = {};
  for (const name of ["harness", "runtime", "studio", "create-agent"]) {
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
        { cwd: join(root, name), capture: true }
      )
    );
    tarballs[name] = join(artifacts, packed[0].filename);
  }
  // Read the actual packed creator template, not the source checkout.
  const creator = join(temporary, "creator");
  await mkdir(creator);
  await run("tar", ["-xzf", tarballs["create-agent"], "-C", creator]);
  const { starterFiles } = await import(
    pathToFileURL(join(creator, "package/dist/scaffold.js")).href
  );
  const compatibility = JSON.parse(
    await readFile(join(creator, "package/compatibility.json"), "utf8")
  );
  const project = join(temporary, "my-agent");
  await mkdir(project);
  const files = await starterFiles(compatibility, true);
  assert.equal(files["scripts/dev.mjs"], undefined);
  assert.equal(files["tsconfig.build.json"], undefined);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), content);
  }
  const manifest = JSON.parse(files["package.json"]);
  for (const name of ["harness", "runtime"])
    manifest.dependencies[`@nylorun/${name}`] = `file:${tarballs[name]}`;
  manifest.devDependencies["@nylorun/studio"] = `file:${tarballs.studio}`;
  await writeFile(
    join(project, "package.json"),
    JSON.stringify(manifest, null, 2)
  );
  await run(
    process.execPath,
    [npmCli(), "install", "--no-audit", "--no-fund"],
    { cwd: project }
  );
  await run(process.execPath, [npmCli(), "run", "check"], { cwd: project });
  await assert.rejects(access(join(project, "dist")));
  // Verify the existing asset-copy contract with a non-TypeScript agent asset.
  await writeFile(join(project, "agents/assistant/fixture.txt"), "asset");
  await run(process.execPath, [npmCli(), "run", "build"], { cwd: project });
  await access(join(project, "dist/src/index.js"));
  assert.equal(
    await readFile(join(project, "dist/agents/assistant/fixture.txt"), "utf8"),
    "asset"
  );
  const port = await availablePort();
  const productionEnv = { ...process.env, PORT: String(port) };
  delete productionEnv.NYLORUN_DEV;
  const production = group.start(
    "production",
    process.execPath,
    ["dist/src/index.js"],
    { cwd: project, env: productionEnv }
  );
  const discoveryUrl = `http://127.0.0.1:${port}/agents/v1/agents`;
  await production.ready(discoveryUrl);
  const productionResponse = await fetch(discoveryUrl, {
    headers: { origin: "http://localhost:4161" },
  });
  assert.equal(
    productionResponse.headers.get("access-control-allow-origin"),
    null
  );
  await production.stop();
  // Keep the generated assistant; inject only a deterministic model adapter for this smoke test.
  await writeFile(
    join(project, "src/index.ts"),
    files["src/index.ts"].replace(
      "new Runtime()",
      'new Runtime({ onModelCall: async () => ({ output: [{ type: "text", text: "Starter smoke response" }], finishReason: "stop" }) })'
    )
  );
  const development = group.start(
    "development",
    process.execPath,
    [
      join(project, "node_modules/@nylorun/runtime/dist/cli.js"),
      "dev",
      "--no-open",
    ],
    { cwd: project, env: { ...process.env, PORT: String(port) } }
  );
  await development.ready(discoveryUrl);
  const line = await development.line((line) => line.startsWith("Studio on "));
  const studio = line.slice("Studio on ".length);
  const response = await fetch(discoveryUrl, { headers: { origin: studio } });
  assert.equal(response.headers.get("access-control-allow-origin"), studio);
  const discovery = await response.json();
  assert.equal(discovery.agents[0].id, "assistant");
  const config = await (
    await fetch(`${studio}/nylo-studio.config.json`)
  ).json();
  assert.equal(config.agentServerUrl, `http://localhost:${port}/agents`);
  const agentManifest = await (
    await fetch(`http://localhost:${port}${discovery.agents[0].manifestUrl}`)
  ).json();
  const streamed = await fetch(
    `http://localhost:${port}${agentManifest.endpoints.agUi}`,
    {
      method: "POST",
      headers: { origin: studio, "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "smoke",
        runId: "smoke",
        messages: [{ id: "input", role: "user", content: "hello" }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    }
  );
  assert.equal(streamed.headers.get("access-control-allow-origin"), studio);
  const events = await streamed.text();
  assert.ok(events.includes("Starter smoke response"), events);
  assert.ok(events.includes("RUN_FINISHED"), events);
  // Actual tsx reload should preserve Studio and serve the edited agent.
  await writeFile(
    join(project, "agents/assistant/agent.ts"),
    files["agents/assistant/agent.ts"].replace(
      'name: "Assistant"',
      'name: "Assistant reloaded"'
    )
  );
  const deadline = Date.now() + 10_000;
  let reloaded = false;
  while (Date.now() < deadline) {
    try {
      reloaded =
        (
          await (
            await fetch(
              `http://localhost:${port}/agents/assistant/manifest.json`
            )
          ).json()
        ).name === "Assistant reloaded";
    } catch {}
    if (reloaded) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(reloaded, "tsx did not reload the edited agent");
  assert.equal((await fetch(`${studio}/nylo-studio.config.json`)).status, 200);
  console.log(
    `Packed starter passed: check/build/assets, production, CORS, discovery, streamed conversation, and watch reload.\nProject: ${project}\nBrowser verification: ${studio}`
  );
  if (keepServing)
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  await development.stop();
  await availablePort(port);
} finally {
  await group.close();
  if (!keepServing) await rm(temporary, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rename,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temporary = await mkdtemp(join(tmpdir(), "nylorun-packed-stack-"));
const children = new Set();
async function command(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, BROWSER: "none" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.once("error", reject);
    child.once("exit", (code) => {
      children.delete(child);
      code === 0
        ? resolve(output)
        : reject(
            new Error(`${bin} ${args.join(" ")} failed (${code}):\n${output}`),
          );
    });
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function launch(args, cwd, ready) {
  return launchCommand(
    process.execPath,
    [join(cwd, "node_modules/@nylorun/runtime/dist/cli.js"), ...args],
    cwd,
    ready,
  );
}
async function launchCommand(bin, args, cwd, ready, env = {}) {
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, BROWSER: "none", ...env },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  let exited = false;
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  child.on("exit", () => {
    children.delete(child);
    exited = true;
  });
  const until = Date.now() + 20_000;
  while (!ready(output)) {
    if (exited || Date.now() > until)
      throw new Error(`CLI did not become ready: ${args.join(" ")}\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    child,
    output: () => output,
    async stop() {
      if (exited) return;
      const done = new Promise((resolve) => child.once("exit", resolve));
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
      await done;
    },
  };
}
async function configure(cwd) {
  const child = spawn(npm, ["run", "configure"], {
    cwd,
    env: { ...process.env, NYLO_CUSTOM_API_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  let sent = 0;
  const questions = [
    ["Choose a provider:", "0"],
    ["OpenAI-compatible base URL:", "http://127.0.0.1:1/v1"],
    ["Model id:", "fixture"],
    ["Custom API key", "fixture-test-api-key"],
  ];
  child.stdout.on("data", (data) => {
    output += data;
    if (questions[sent] && output.includes(questions[sent][0]))
      child.stdin.write(questions[sent++][1] + "\n");
  });
  child.stderr.on("data", (data) => (output += data));
  const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, `configure failed: ${output}`);
    assert.equal(
      JSON.parse(await readFile(join(cwd, "config/model.json"), "utf8")).model,
      "fixture",
    );
  } finally {
    clearTimeout(timer);
    children.delete(child);
  }
}
try {
  console.log("Packing workspace packages...");
  const tarballs = process.env.NYLORUN_STACK_TARBALLS
    ? JSON.parse(await readFile(process.env.NYLORUN_STACK_TARBALLS, "utf8"))
    : {};
  for (const name of ["harness", "runtime", "studio", "create-agent"]) {
    if (tarballs[name]) continue;
    if (process.env.NYLORUN_STACK_TARBALLS)
      throw new Error(`Missing exact-stack tarball: ${name}`);
    const output = await command(
      npm,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      join(repo, name),
    );
    tarballs[name] = join(temporary, JSON.parse(output)[0].filename);
  }
  // Load the renderer from the packed creator, rather than the repository source.
  const extracted = join(temporary, "creator");
  await mkdir(extracted);
  execFileSync("tar", ["-xzf", tarballs["create-agent"], "-C", extracted]);
  const { starterFiles } = await import(
    pathToFileURL(join(extracted, "package/dist/scaffold.js"))
  );
  const compatibility = JSON.parse(
    await readFile(join(extracted, "package/compatibility.json"), "utf8"),
  );
  const { createProject } = await import(
    pathToFileURL(join(extracted, "package/dist/project.js"))
  );
  const project = join(temporary, "application");
  const creationCommands = [];
  const creationPort = await freePort();
  // Use the packed creator's real sequencing, supplying local tarballs at the
  // filesystem boundary. Every stage runs the generated application's scripts.
  await createProject(
    { directory: "application", studio: true, open: false, yes: true },
    compatibility,
    {
      currentDirectory: () => temporary,
      isInteractive: () => true,
      log: console.log,
      exists: async (path) => existsSync(path),
      makeDirectory: async (path) => {
        await mkdir(path, { recursive: true });
      },
      rename,
      remove: async (path) => rm(path, { recursive: true, force: true }),
      write: async (path, content) => {
        if (
          path.endsWith(
            `${process.platform === "win32" ? "\\" : "/"}package.json`,
          )
        ) {
          const manifest = JSON.parse(content);
          for (const name of ["harness", "runtime"])
            manifest.dependencies[
              `@nylorun/${name}`
            ] = `file:${tarballs[name]}`;
          manifest.devDependencies[
            "@nylorun/studio"
          ] = `file:${tarballs.studio}`;
          content = JSON.stringify(manifest, null, 2);
        }
        await writeFile(path, content);
      },
      run: async (_bin, args, cwd) => {
        creationCommands.push([...args]);
        assert.equal(cwd, project);
        if (args[0] === "install") {
          await command(
            npm,
            [...args, "--ignore-scripts", "--no-audit", "--no-fund"],
            cwd,
          );
        } else if (args[1] === "configure") {
          await configure(cwd);
        } else {
          assert.equal(
            JSON.parse(await readFile(join(cwd, "config/model.json"), "utf8"))
              .model,
            "fixture",
          );
          assert.equal(
            JSON.parse(await readFile(join(cwd, ".env/auth.json"), "utf8"))
              .custom.key,
            "fixture-test-api-key",
          );
          const dev = await launchCommand(
            npm,
            args,
            cwd,
            (output) => output.includes("Studio on"),
            { PORT: String(creationPort) },
          );
          try {
            const discovery = await (
              await fetch(`http://127.0.0.1:${creationPort}/v1/agents`)
            ).json();
            assert.equal(discovery.agents[0].id, "assistant");
          } finally {
            await dev.stop();
          }
        }
        return { status: 0 };
      },
    },
  );
  assert.deepEqual(creationCommands, [
    ["install", "--yes"],
    ["run", "configure"],
    ["run", "dev", "--", "--no-open"],
  ]);
  await command(npm, ["run", "check"], project);
  const cli = join(project, "node_modules/@nylorun/runtime/dist/cli.js");
  const inspected = JSON.parse(
    await command(process.execPath, [cli, "inspect"], project),
  );
  assert.equal(inspected.agents[0].id, "assistant");
  assert.equal(inspected.setup, "ready");
  console.log(
    "Generated typing, inspect, and configure passed; checking dev and Studio...",
  );
  // A deterministic ordinary Harness agent tests runtime commands without live providers.
  const fixture = (text) => `
import { Agent, tool } from "@nylorun/harness";
import { z } from "zod";
export const assistant = Agent({ id: "assistant", name: "${text}" })
  .use({ id: "ask", tools: [tool({ name: "ask", inputSchema: z.object({}), execute: async (_input, context) => context.resume ? { kind: "completed", output: "answered" } : { kind: "interaction-required", interaction: { kind: "response", prompt: "Answer?" } } })] })
  .with(async (call) => call.prompt.some((item) => item.kind === "message" && item.content.some((part) => part.type === "text" && part.text === "wait")) && !call.prompt.some((item) => item.kind === "tool-result") ? { output: [{ type: "tool-call", id: "ask", name: "ask", args: {} }] } : "${text}")
  .build();
`;

  await writeFile(join(project, "agent/assistant/agent.ts"), fixture("first"));
  const mediaConfig = (root) => `
import { defineRuntime, localMedia } from "@nylorun/runtime";
import { agents } from "./agent/registry.js";
export default defineRuntime({ agents, media: localMedia({ root: ${JSON.stringify(root)} }) });
`;
  await writeFile(
    join(project, "nylorun.config.ts"),
    mediaConfig(".data/media-first"),
  );
  const port = await freePort();
  const dev = await launch(
    ["dev", "--no-studio", "--no-open", "--port", String(port)],
    project,
    (output) => output.includes("Agent runtime on"),
  );
  const url = `http://127.0.0.1:${port}`;
  const run = async (threadId, content = "hello") => {
    const response = await fetch(`${url}/agents/assistant/v1/ag-ui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        messages: [{ role: "user", content }],
      }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  assert.match(await run("old"), /first/);
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  await run("with-image", [
    {
      type: "image",
      source: {
        type: "data",
        mimeType: "image/png",
        value: imageBytes.toString("base64"),
      },
    },
  ]);
  const imageHistory = await (
    await fetch(`${url}/agents/assistant/v1/ag-ui/sessions/with-image`)
  ).json();
  const imageUrl = imageHistory.messages[0].content[0].url;
  await run("waiting", "wait");
  await writeFile(join(project, "agent/assistant/agent.ts"), fixture("second"));
  for (let i = 0; i < 100 && !dev.output().includes("Reloaded"); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(dev.output(), /Reloaded/);
  assert.match(await run("new"), /second/);
  const listed = await (
    await fetch(`${url}/agents/assistant/v1/sessions`)
  ).json();
  assert.deepEqual(
    listed.sessions.map((session) => session.session).sort(),
    ["new", "old", "waiting", "with-image"],
  );
  assert.equal(
    listed.sessions.find((session) => session.session === "waiting").status,
    "waiting",
  );
  await writeFile(
    join(project, "nylorun.config.ts"),
    mediaConfig(".data/media-second"),
  );
  for (
    let i = 0;
    i < 100 && !dev.output().includes("Reloaded nylorun.config.ts");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(dev.output(), /Reloaded nylorun.config.ts/);
  const retainedImage = await fetch(`${url}${imageUrl}`);
  assert.equal(retainedImage.status, 200);
  assert.deepEqual(Buffer.from(await retainedImage.arrayBuffer()), imageBytes);
  const pending = await (
    await fetch(`${url}/agents/assistant/v1/sessions/waiting`)
  ).json();
  assert.equal(pending.state, "waiting");
  const answered = await fetch(`${url}/agents/assistant/v1/sessions/waiting`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      interaction: {
        id: pending.pending_interaction.id,
        kind: "respond",
        value: "answer",
      },
    }),
  });
  assert.equal(answered.status, 202);
  const history = await (
    await fetch(`${url}/agents/assistant/v1/ag-ui/sessions/waiting`)
  ).json();
  assert.equal(history.messages.at(-1).content[0].text, "first");

  assert.match(await run("old"), /first/);
  await writeFile(
    join(project, "agent/assistant/agent.ts"),
    "invalid typescript !!!!",
  );
  for (let i = 0; i < 100 && !dev.output().includes("Reload failed"); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(dev.output(), /Reload failed/);
  assert.match(await run("after-failure"), /second/);
  const dashboard = await launch(
    ["studio", "--agent-url", url, "--no-open"],
    project,
    (output) => output.includes("Studio on"),
  );
  const studioUrl = dashboard.output().match(/Studio on (http[^\s]+)/)[1];
  assert.equal((await fetch(studioUrl)).status, 200);
  const [studioConfig, clientRoute, legacyRoute] = await Promise.all([
    fetch(`${studioUrl}/nylo-studio.config.json`),
    fetch(`${studioUrl}/a/client/route`),
    fetch(`${studioUrl}/_studio/health`),
  ]);
  assert.equal(studioConfig.status, 200);
  assert.equal((await studioConfig.json()).agentServerUrl, url);
  assert.equal(clientRoute.status, 200);
  assert.match(await clientRoute.text(), /Nylo Studio/);
  assert.equal(legacyRoute.status, 404);
  await dashboard.stop();
  assert.equal((await fetch(`${url}/v1/agents`)).status, 200);
  await dev.stop();
  await writeFile(join(project, "agent/assistant/agent.ts"), fixture("built"));
  const combinedPort = await freePort();
  const combined = await launch(
    ["dev", "--no-open", "--port", String(combinedPort)],
    project,
    (output) => output.includes("Studio on"),
  );
  await combined.stop();
  await command(process.execPath, [cli, "build"], project);
  await rename(join(project, "agent"), join(project, "authored-source-away"));
  await rename(
    join(project, "node_modules/@nylorun/studio"),
    join(project, "studio-away"),
  );
  const productionPort = await freePort();
  const production = await launch(
    ["start", "--port", String(productionPort)],
    project,
    (output) => output.includes("Agent runtime on"),
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${productionPort}/v1/agents`)).status,
    200,
  );
  await production.stop();
  // Install a separate headless scaffold and exercise it without Studio or Harness on disk.
  const headless = join(temporary, "headless");
  await mkdir(headless);
  for (const [path, content] of Object.entries(
    await starterFiles(compatibility, false),
  )) {
    await mkdir(dirname(join(headless, path)), { recursive: true });
    await writeFile(join(headless, path), content);
  }
  const headlessManifest = JSON.parse(
    await readFile(join(headless, "package.json"), "utf8"),
  );
  headlessManifest.dependencies[
    "@nylorun/harness"
  ] = `file:${tarballs.harness}`;
  headlessManifest.dependencies[
    "@nylorun/runtime"
  ] = `file:${tarballs.runtime}`;
  await writeFile(
    join(headless, "package.json"),
    JSON.stringify(headlessManifest),
  );
  await command(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    headless,
  );
  await command(npm, ["run", "check"], headless);
  await command(npm, ["run", "build"], headless);
  await writeFile(
    join(headless, "nylorun.config.ts"),
    'import { defineRuntime } from "@nylorun/runtime"; export default defineRuntime({ agents: [] });\n',
  );
  await rm(join(headless, "node_modules/@nylorun/harness"), {
    recursive: true,
  });
  const independentCli = join(
    headless,
    "node_modules/@nylorun/runtime/dist/cli.js",
  );
  assert.deepEqual(
    JSON.parse(
      await command(process.execPath, [independentCli, "inspect"], headless),
    ).agents,
    [],
  );
  console.log(
    "Packed stack passed: creator install/configure/start sequence, generated typing, configure, inspect, dev, reload, failed reload, Studio attach, combined Studio, build, production without Studio/source, and independent Runtime.",
  );
} finally {
  for (const child of children) child.kill("SIGTERM");
  await rm(temporary, { recursive: true, force: true });
}

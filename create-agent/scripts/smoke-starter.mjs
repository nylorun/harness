import { createHash } from 'node:crypto';
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { root, npmCli, run } from "../../scripts/lib/repo.mjs";
import { ProcessGroup } from "../../scripts/lib/processes.mjs";
import { availablePort } from "../../scripts/lib/development.mjs";
const temporary = await mkdtemp(join(tmpdir(), "nylorun-release-"));
const group = new ProcessGroup();
let browser;
// Declared outside the try so the finally can reap detached Runtimes started in either project.
const projects = [];
const tarballs = process.env.NYLORUN_STACK_TARBALLS
  ? JSON.parse(await readFile(process.env.NYLORUN_STACK_TARBALLS, "utf8"))
  : {};
const names = ["core", "harness", "agents", "runtime", "studio", "cli", "create-agent"];
try {
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts);
  for (const name of names) {
    if (tarballs[name]) continue;
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
  await mkdir(join(root, ".tmp/release-local"), { recursive: true });
  const identities = {};
  for (const name of names) identities[name] = { file: tarballs[name].split("/").at(-1), sha256: createHash("sha256").update(await readFile(tarballs[name])).digest("hex") };
  await writeFile(join(root, ".tmp/release-local/artifacts.json"), JSON.stringify(identities, null, 2) + "\n");
  const creator = join(temporary, "creator");
  await mkdir(creator);
  await run("tar", ["-xzf", tarballs["create-agent"], "-C", creator]);
  const { starterFiles } = await import(
    pathToFileURL(join(creator, "package/dist/scaffold.js")).href
  );
  const pins = JSON.parse(
    await readFile(join(creator, "package/compatibility.json"), "utf8"),
  );
  for (const studio of [true, false]) {
    const project = join(temporary, studio ? "with-studio" : "headless");
    await mkdir(project);
    const files = await starterFiles(pins, studio);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), content);
    }
    const manifest = JSON.parse(files["package.json"]);
    // Pin the entire release combination, including the SDK's transitive harness, to exact packed artifacts.
    for (const name of ["core", "harness", "agents", "runtime", "cli"])
      manifest.dependencies[`@nylorun/${name}`] = `file:${tarballs[name]}`;
    if (studio)
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
    await run(process.execPath, [npmCli(), "run", "build"], { cwd: project });
    projects.push(project);
  }
  const project = projects[0];
  // The Runtime is a separate, persistent process now, so the smoke drives it explicitly.
  const nylorun = (cwd, args, extra = {}) =>
    run(
      process.execPath,
      [join(cwd, "node_modules/@nylorun/cli/dist/cli.js"), ...args],
      { cwd, ...extra },
    );
  const runtimePid = async (cwd) =>
    Number(
      await readFile(join(cwd, ".nylorun/runtime.pid"), "utf8").catch(() => ""),
    ) || undefined;
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    NYLORUN_DEV_MODEL: "fixture",
  };
  const dev = group.start(
    "generated-dev",
    process.execPath,
    [npmCli(), "run", "dev", "--", "--no-open"],
    { cwd: project, env },
  );
  const line = await dev.line((l) => l.startsWith("Studio on "));
  const studioUrl = line.slice("Studio on ".length);
  await dev.line((l) => l.startsWith("Local project ready"));
  const credentials = JSON.parse(
    await readFile(join(project, ".nylorun/local-credentials.json"), "utf8"),
  );
  assert.equal(
    (await stat(join(project, ".nylorun/local-credentials.json"))).mode & 0o777,
    0o600,
  );
  const configText = await (
    await fetch(studioUrl + "/nylo-studio.config.json")
  ).text();
  assert.ok(!configText.includes(credentials.serverKey));
  assert.ok(!configText.includes("executor"));
  const forbidden = await fetch(studioUrl + "/_studio/runtime/v1/actions");
  assert.equal(forbidden.status, 404);
  const csrf = await fetch(studioUrl + "/_studio/runtime/v1/sessions/nope", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(csrf.status, 403);
  browser = await chromium.launch({
    executablePath:
      process.env.NYLORUN_CHROME_PATH ??
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(studioUrl);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Look up order demo-123");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText("Tool · lookup_order · completed", { exact: true })
    .waitFor({ timeout: 20000 });
  await page.getByText("Assistant", { exact: true }).waitFor();
  assert.match(await page.locator("main").innerText(), /shipped/);
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("What did I ask earlier?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // Chat column only — the Events table also summarizes the same reply text.
  const transcript = page.locator("section").filter({
    has: page.getByRole("textbox", { name: "Message" }),
  });
  await transcript.getByText(/I remember:/).waitFor();
  const sessionUrl = page.url();
  const sessionId = sessionUrl.split("/").at(-1);
  await page.reload();
  await transcript.getByText(/I remember:/).waitFor();
  assert.match(await page.locator("main").innerText(), /demo-123/);
  assert.deepEqual(errors, []);
  await mkdir(join(root, ".tmp/release-local"), { recursive: true });
  await page.screenshot({
    path: join(root, ".tmp/release-local/studio.png"),
    fullPage: true,
  });
  // One ordinary source edit must restart the stack and register the updated definition.
  const source = join(project, "agents/assistant/agent.ts");
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace(
      "Order assistant",
      "Updated order assistant",
    ),
  );
  let updated = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(url + "/v1/agents", {
        headers: { authorization: `Bearer ${credentials.serverKey}` },
      });
      const body = await response.json();
      if (body.agents?.[0]?.manifest.name === "Updated order assistant") {
        updated = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(updated, "source edit restarted registry");
  // A source edit re-registers against the same host rather than respawning it.
  const devPid = await runtimePid(project);
  assert.ok(devPid, "dev started a Runtime");
  assert.equal(
    (await (await fetch(`${url}/health`)).json()).pid,
    devPid,
    "source edit reused the running Runtime",
  );
  await dev.stop();
  // Stopping dev must leave the Runtime up; the compiled check attaches to this same host.
  assert.equal((await (await fetch(`${url}/health`)).json()).pid, devPid);
  await run(process.execPath, [npmCli(), "run", "build"], { cwd: project });
  const started = group.start(
    "compiled-start",
    process.execPath,
    [npmCli(), "start"],
    { cwd: project, env },
  );
  await started.line((l) => l.startsWith("Local project ready"));
  assert.equal(
    await runtimePid(project),
    devPid,
    "compiled serve attached to the running Runtime",
  );
  const sdk = await import(
    pathToFileURL(join(project, "node_modules/@nylorun/agents/dist/index.js"))
      .href
  );
  const client = sdk.createClient({ url, key: credentials.serverKey });
  const restored = await client.session(sessionId).history();
  assert.ok(restored.items.some((e) => e.type === "turn.completed"));
  const session = await client.createSession({
    agentId: "assistant",
    ownerUserId: "local-developer",
  });
  await session.input("Look up order demo-123", {
    idempotencyKey: crypto.randomUUID(),
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20000);
  let complete = false;
  try {
    for await (const event of session.observe({ signal: abort.signal })) {
      if (event.type === "turn.failed")
        throw new Error(JSON.stringify(event.payload));
      if (event.type === "turn.completed") {
        assert.match(JSON.stringify(event.payload), /shipped/);
        complete = true;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  assert.ok(complete, "compiled start executes tool");
  await started.stop();
  await nylorun(project, ["down"]);
  assert.equal(await runtimePid(project), undefined);
  await assert.rejects(fetch(`${url}/health`));
  // Stopping the Runtime keeps its data.
  await stat(join(project, ".nylorun/runtime.sqlite"));
  await stat(join(project, ".nylorun/local-credentials.json"));
  const headlessPort = await availablePort();
  const headlessEnv = { ...env, PORT: String(headlessPort) };
  const headless = group.start(
    "headless-dev",
    process.execPath,
    [npmCli(), "run", "dev", "--", "--no-open"],
    { cwd: projects[1], env: headlessEnv },
  );
  await headless.line((l) => l.startsWith("Local project ready"));
  await headless.stop();
  // serve autostarts before the model credential is checked, so this failure path also has a
  // Runtime to clean up; the port is explicit so it can never collide with a real 8787.
  const missing = group.start(
    "missing-config",
    process.execPath,
    [npmCli(), "start"],
    {
      cwd: projects[1],
      env: {
        ...process.env,
        PORT: String(headlessPort),
        NYLORUN_DEV_MODEL: "",
      },
    },
  );
  await missing.line((l) => l.includes("not configured"));
  assert.notEqual(await missing.exit, 0);
  await nylorun(projects[1], ["down"]);
  console.log(
    "PASS: packed creator, both starters, browser tool/results/history, source restart, compiled tool execution, shutdown, credentials, and missing-configuration error.",
  );
} finally {
  // Detached Runtimes are deliberately outside the process group, so reap them by pid.
  for (const project of projects)
    try {
      const pid = Number(
        await readFile(join(project, ".nylorun/runtime.pid"), "utf8"),
      );
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch {}
  await browser?.close();
  await group.close();
  await rm(temporary, { recursive: true, force: true });
}

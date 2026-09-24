import { createHash } from "node:crypto";
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
const projects = [];
const tarballs = process.env.NYLORUN_STACK_TARBALLS
  ? JSON.parse(await readFile(process.env.NYLORUN_STACK_TARBALLS, "utf8"))
  : {};
const names = [
  "core",
  "harness",
  "agents",
  "runtime",
  "studio",
  "cli",
  "create-agent",
];

const readyLine = (l) =>
  l.includes("Ready") || l.includes("Ctrl-C stops this Project only");
const studioLine = (l) => /^\s*Studio\s+http/.test(l);
const hostLine = (l) => /^\s*Host\s+http/.test(l);

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
  for (const name of names)
    identities[name] = {
      file: tarballs[name].split("/").at(-1),
      sha256: createHash("sha256")
        .update(await readFile(tarballs[name]))
        .digest("hex"),
    };
  await writeFile(
    join(root, ".tmp/release-local/artifacts.json"),
    JSON.stringify(identities, null, 2) + "\n",
  );
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
    for (const name of ["agents"])
      manifest.dependencies[`@nylorun/${name}`] = `file:${tarballs[name]}`;
    // Keep Runtime and Core reachable for the CLI until Wave 2 rewires serve/dev.
    for (const name of ["core", "harness", "runtime"])
      manifest.dependencies[`@nylorun/${name}`] = `file:${tarballs[name]}`;
    manifest.devDependencies ??= {};
    manifest.devDependencies["@nylorun/cli"] = `file:${tarballs.cli}`;
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
  const home = await mkdtemp(join(tmpdir(), "nylorun-release-home-"));
  // Fixture models are only allowed on ephemeral Hosts; release smoke uses
  // `--ephemeral` so NYLORUN_DEV_MODEL=fixture can drive Studio and SDK turns.
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NYLORUN_DEV_MODEL: "fixture",
  };
  const readAuth = async (cwd) => {
    const credentials = JSON.parse(
      await readFile(join(cwd, ".nylorun/credentials.json"), "utf8"),
    );
    const link = JSON.parse(
      await readFile(join(cwd, ".nylorun/link.json"), "utf8"),
    );
    return { credentials, link };
  };

  const dev = group.start(
    "generated-dev",
    process.execPath,
    [npmCli(), "run", "dev", "--", "--no-open", "--ephemeral"],
    { cwd: project, env },
  );
  const hostBanner = await dev.line(hostLine, 90_000);
  const url = hostBanner.trim().replace(/^Host\s+/, "").split(/\s+/)[0];
  const line = await dev.line(studioLine, 60_000);
  const studioUrl = line.trim().replace(/^Studio\s+/, "");
  await dev.line(readyLine, 60_000);
  const { credentials, link } = await readAuth(project);
  assert.equal(
    (await stat(join(project, ".nylorun/credentials.json"))).mode & 0o777,
    0o600,
  );
  const configText = await (
    await fetch(studioUrl + "/nylo-studio.config.json")
  ).text();
  assert.ok(!configText.includes(credentials.applicationKey));
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
  try {
    await page
      .getByText("Tool · lookup_order · completed", { exact: true })
      .waitFor({ timeout: 20000 });
  } catch (error) {
    const text = await page.locator("body").innerText();
    await page.screenshot({
      path: join(root, ".tmp/release-local/studio-fail.png"),
      fullPage: true,
    });
    throw new Error(
      `tool completion missing.\n${text.slice(0, 2000)}\n${error instanceof Error ? error.message : error}`,
    );
  }
  await page.getByText("Assistant", { exact: true }).first().waitFor();
  assert.match(await page.locator("main").innerText(), /shipped|Order lookup complete/i);
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("What did I ask earlier?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const transcript = page.locator("section").filter({
    has: page.getByRole("textbox", { name: "Message" }),
  });
  await transcript.getByText(/I remember:/).waitFor({ timeout: 20000 });
  const sessionUrl = page.url();
  const sessionId = sessionUrl.split("/").at(-1);
  await page.reload();
  await transcript.getByText(/I remember:/).waitFor({ timeout: 20000 });
  assert.match(await page.locator("main").innerText(), /demo-123/);
  assert.deepEqual(errors, []);
  await mkdir(join(root, ".tmp/release-local"), { recursive: true });
  await page.screenshot({
    path: join(root, ".tmp/release-local/studio.png"),
    fullPage: true,
  });

  const source = join(project, "agents/assistant/agent.ts");
  const beforeEditUrl = (await readAuth(project)).link.hostUrl;
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace(
      "Order assistant",
      "Updated order assistant",
    ),
  );
  // tsx watch restarts the Project under a new ephemeral Host; wait for the link to move.
  let afterEdit;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      afterEdit = await readAuth(project);
      if (afterEdit.link.hostUrl !== beforeEditUrl) break;
    } catch {
      /* link may be briefly missing during restart */
    }
    afterEdit = undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(afterEdit, "source edit did not recreate the Project link");
  const editUrl = afterEdit.link.hostUrl;
  let updated = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${editUrl}/v1/agents`, {
        headers: {
          authorization: `Bearer ${afterEdit.credentials.applicationKey}`,
          "Nylorun-Tenant": afterEdit.link.tenantId,
          "Nylorun-Protocol": "2",
        },
      });
      const body = await response.json();
      if (
        body.agents?.some(
          (agent) => agent.manifest?.name === "Updated order assistant",
        )
      ) {
        updated = true;
        break;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(updated, "source edit restarted registry");
  await dev.stop();
  await assert.rejects(fetch(`${editUrl}/health`));
  await stat(join(project, ".nylorun/credentials.json"));
  await stat(join(project, ".nylorun/link.json"));

  await run(process.execPath, [npmCli(), "run", "build"], { cwd: project });
  // Until the CLI drops `serve`, compile-check uses env from a short-lived
  // `nylorun serve --ephemeral` so `node dist/src/main.js` can connect.
  const serve = group.start(
    "serve-host",
    process.execPath,
    [join(project, "node_modules/@nylorun/cli/dist/cli.js"), "serve", "--ephemeral"],
    { cwd: project, env },
  );
  const serveHost = await serve.line(hostLine, 90_000);
  const serveUrl = serveHost.trim().replace(/^Host\s+/, "").split(/\s+/)[0];
  await serve.line(readyLine, 60_000);
  const served = await readAuth(project);
  const startEnv = {
    ...env,
    NYLORUN_RUNTIME_URL: serveUrl,
    NYLORUN_TENANT: served.link.tenantId,
    NYLORUN_SERVER_KEY: served.credentials.applicationKey,
  };
  const started = group.start(
    "compiled-start",
    process.execPath,
    [join(project, "dist/src/main.js")],
    { cwd: project, env: startEnv },
  );
  await new Promise((r) => setTimeout(r, 2000));
  const sdk = await import(
    pathToFileURL(join(project, "node_modules/@nylorun/agents/dist/index.js"))
      .href
  );
  const client = sdk.createClient({
    url: serveUrl,
    key: served.credentials.applicationKey,
    tenant: served.link.tenantId,
  });
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
        complete = true;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  assert.ok(complete, "compiled start executes a turn");
  void sessionId;
  await started.stop();
  await serve.stop();

  const headless = group.start(
    "headless-dev",
    process.execPath,
    [npmCli(), "run", "dev", "--", "--no-open", "--ephemeral"],
    { cwd: projects[1], env },
  );
  await headless.line(readyLine, 90_000);
  await headless.stop();

  const missingPort = await availablePort();
  const missing = group.start(
    "missing-config",
    process.execPath,
    [
      join(projects[1], "node_modules/@nylorun/cli/dist/cli.js"),
      "serve",
      "--ephemeral",
    ],
    {
      cwd: projects[1],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PORT: String(missingPort),
        NYLORUN_DEV_MODEL: "",
      },
    },
  );
  await missing.line(
    (l) =>
      l.includes("not configured") ||
      l.includes("Model") ||
      l.includes("provider") ||
      l.includes("configure"),
    60_000,
  );
  assert.notEqual(await missing.exit, 0);

  console.log(
    "PASS: packed creator, both starters (ephemeral Host + fixture), browser tool/results, source restart, compiled tool execution, shutdown, credentials, and missing-configuration error.",
  );
} finally {
  await browser?.close();
  await group.close();
  await rm(temporary, { recursive: true, force: true });
}

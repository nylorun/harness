import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { npmCli, run } from "../lib/repo.mjs";
import { ProcessGroup } from "../lib/processes.mjs";
import { availablePort } from "../lib/development.mjs";
import { installRuntime } from "../lib/runtime-install.mjs";

export function publicCreatorArguments(version) {
  return [
    "exec",
    "--yes",
    `--package=@nylorun/create-agent@${version}`,
    "--",
    "create-agent",
    "application",
    "--yes",
  ];
}

export function publicCreatorEnvironment(environment, npmrc, port, extras = {}) {
  // Installation scripts must not inherit publishing credentials or OIDC access.
  const clean = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !/token|secret|password|credential|api.?key/i.test(key) &&
        !/^npm_config_(?:userconfig|globalconfig|.*auth.*)$/i.test(key),
    ),
  );
  return {
    ...clean,
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_GLOBALCONFIG: npmrc + ".global",
    PORT: String(port),
    NYLORUN_DEV_MODEL: "fixture",
    ...extras,
  };
}

/**
 * `nylorun dev` prints its banner before the project runner finishes
 * registering seed agents. Poll discovery until `assistant` appears.
 */
async function waitForSeedAgent(
  hostUrl,
  applicationKey,
  tenantId,
  timeoutMs = 60_000,
) {
  const url = new URL("/v1/agents", hostUrl);
  const headers = {
    authorization: `Bearer ${applicationKey}`,
    "Nylorun-Tenant": tenantId,
    "Nylorun-Protocol": "2",
  };
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) {
        const body = await response.json();
        if (JSON.stringify(body).includes('"assistant"')) return body;
        last = `agents=${JSON.stringify(body.agents ?? null)}`;
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Public creator did not serve its seed agent (${last}).`);
}

/**
 * Install the published Runtime as a developer would (the prerequisite), then
 * create and start a project with the published creator.
 */
export async function publicCreatorSmoke(version, runtimeVersion) {
  const temporary = await mkdtemp(join(tmpdir(), "nylorun-published-"));
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-published-host-"));
  const home = await mkdtemp(join(tmpdir(), "nylorun-published-home-"));
  const project = join(temporary, "application");
  const group = new ProcessGroup();
  let environment;
  let runtime;
  try {
    const port = await availablePort();
    const npmrc = join(temporary, ".npmrc");
    await writeFile(npmrc, "");
    await writeFile(npmrc + ".global", "");
    environment = publicCreatorEnvironment(process.env, npmrc, port, {
      NYLORUN_HOME: hostRoot,
      HOME: home,
      USERPROFILE: home,
    });
    runtime = await installRuntime(
      join(temporary, "runtime"),
      `@nylorun/runtime@${runtimeVersion}`,
      { env: environment },
    );
    const child = group.start(
      "public-creator",
      process.execPath,
      [npmCli(), ...publicCreatorArguments(version)],
      {
        cwd: temporary,
        env: runtime.env(environment),
      },
    );
    // The Host picks its own port (host.json), so find it through the link
    // `dev` writes before its banner.
    await child.line(
      (line) => line.includes("Ctrl-C stops this Project only"),
      120_000,
    );
    const link = JSON.parse(
      await readFile(join(project, ".nylorun/link.json"), "utf8"),
    );
    const credentials = JSON.parse(
      await readFile(join(project, ".nylorun/credentials.json"), "utf8"),
    );
    await waitForSeedAgent(
      link.hostUrl,
      credentials.applicationKey ?? credentials.serverKey,
      link.tenantId,
    );
  } finally {
    await group.close();
    // The Host outlives `dev`; stop it before removing its root.
    if (environment)
      await run(
        process.execPath,
        [
          join(project, "node_modules/@nylorun/cli/dist/cli.js"),
          "runtime",
          "down",
          "--force",
        ],
        {
          cwd: project,
          env: runtime?.env(environment) ?? environment,
          capture: true,
        },
      ).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
    await rm(hostRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

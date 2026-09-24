import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { npmCli } from "../lib/repo.mjs";
import { ProcessGroup } from "../lib/processes.mjs";
import { availablePort } from "../lib/development.mjs";

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
 * Persistent Host answers /ready before the project runner finishes
 * registering seed agents. Poll discovery until `assistant` appears.
 */
async function waitForSeedAgent(port, applicationKey, tenantId, timeoutMs = 30_000) {
  const url = `http://127.0.0.1:${port}/v1/agents`;
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

export async function publicCreatorSmoke(version) {
  const temporary = await mkdtemp(join(tmpdir(), "nylorun-published-"));
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-published-host-"));
  const home = await mkdtemp(join(tmpdir(), "nylorun-published-home-"));
  const group = new ProcessGroup();
  try {
    const port = await availablePort();
    const npmrc = join(temporary, ".npmrc");
    await writeFile(npmrc, "");
    await writeFile(npmrc + ".global", "");
    const child = group.start(
      "public-creator",
      process.execPath,
      [npmCli(), ...publicCreatorArguments(version)],
      {
        cwd: temporary,
        env: publicCreatorEnvironment(process.env, npmrc, port, {
          NYLORUN_HOME: hostRoot,
          HOME: home,
          USERPROFILE: home,
        }),
      },
    );
    await child.ready(`http://127.0.0.1:${port}/ready`, 120_000);
    const link = JSON.parse(
      await readFile(join(temporary, "application/.nylorun/link.json"), "utf8"),
    );
    const credentials = JSON.parse(
      await readFile(
        join(temporary, "application/.nylorun/credentials.json"),
        "utf8",
      ),
    );
    await waitForSeedAgent(
      port,
      credentials.applicationKey ?? credentials.serverKey,
      link.tenantId,
    );
  } finally {
    await group.close();
    await rm(temporary, { recursive: true, force: true });
    await rm(hostRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

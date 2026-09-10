import { mkdtemp, rm } from "node:fs/promises";
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
    "--no-open",
    "--skip-config",
  ];
}

export async function publicCreatorSmoke(version) {
  const temporary = await mkdtemp(join(tmpdir(), "nylorun-published-"));
  const group = new ProcessGroup();
  try {
    const port = await availablePort();
    const child = group.start(
      "public-creator",
      process.execPath,
      [npmCli(), ...publicCreatorArguments(version)],
      { cwd: temporary, env: { ...process.env, PORT: String(port) } },
    );
    await child.ready(`http://127.0.0.1:${port}/v1/agents`, 120_000);
    const studioLine = await child.line((line) =>
      line.includes("Studio on http"),
    );
    await child.ready(studioLine.match(/Studio on (https?:\/\/\S+)/)[1]);
    const discovery = await (
      await fetch(`http://127.0.0.1:${port}/v1/agents`)
    ).json();
    if (!JSON.stringify(discovery).includes('"assistant"'))
      throw new Error("Public creator did not serve its seed agent.");
  } finally {
    await group.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

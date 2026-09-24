import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runLauncher } from "../../src/launcher/commands.js";
import { ensureHostLayout, hostPaths } from "../../src/launcher/paths.js";
import type { LauncherEvent } from "../../src/launcher/protocol.js";
import { writeFakeBuild } from "./fixtures/fake-build.js";
import {
  currentPlatformArch,
  removeRoot,
  temporaryRoot,
} from "./fixtures/registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    sink: {
      json: false,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

it("E1-7: --json emits NDJSON result and errors carry remedy; exit 0/1/2", async () => {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  const current = currentPlatformArch();
  const version = "0.9.9-json";
  const source = await temporaryRoot("nylorun-build-");
  roots.push(source);
  await writeFakeBuild(source, { version, ...current });

  const ok = capture();
  ok.sink.json = true;
  const code0 = await runLauncher(
    ["--json", "--home", root, "install", version, "--from", source],
    {
      home: root,
      registry: "http://127.0.0.1:9",
      ...current,
      sink: ok.sink,
    },
  );
  expect(code0).toBe(0);
  const resultLine = JSON.parse(ok.stdout.at(-1)!) as LauncherEvent;
  expect(resultLine.type).toBe("result");
  expect(resultLine).toMatchObject({
    version,
    installed: true,
  });

  const fail = capture();
  fail.sink.json = true;
  const code1 = await runLauncher(
    ["--json", "--home", root, "install", "no-such-version"],
    {
      home: root,
      registry: "http://127.0.0.1:9",
      ...current,
      sink: fail.sink,
    },
  );
  expect(code1).toBe(1);
  const errorLine = JSON.parse(fail.stdout.at(-1)!) as Extract<
    LauncherEvent,
    { type: "error" }
  >;
  expect(errorLine.type).toBe("error");
  expect(errorLine.remedy.length).toBeGreaterThan(0);
  expect(errorLine.code).toBeTruthy();

  const usage = capture();
  usage.sink.json = true;
  const code2 = await runLauncher(["--json", "not-a-command"], {
    home: root,
    registry: "http://127.0.0.1:9",
    ...current,
    sink: usage.sink,
  });
  expect(code2).toBe(2);
  expect(usage.stderr.join("\n")).toMatch(/Unknown command|Usage/);
});

it("E1-7: status --json matches StatusResult shape", async () => {
  const root = await temporaryRoot();
  roots.push(root);
  await ensureHostLayout(hostPaths(root));
  const current = currentPlatformArch();
  await writeFakeBuild(join(hostPaths(root).runtime, "0.9.0-beta"), {
    version: "0.9.0-beta",
    ...current,
  });
  const cap = capture();
  cap.sink.json = true;
  const code = await runLauncher(["--json", "--home", root, "status"], {
    home: root,
    registry: "http://127.0.0.1:9",
    ...current,
    sink: cap.sink,
  });
  expect(code).toBe(0);
  const body = JSON.parse(cap.stdout.at(-1)!) as Record<string, unknown>;
  expect(body.type).toBe("result");
  expect(body.launcherProtocol).toBe(1);
  expect(body.state).toBe("absent");
  expect(body.installed).toEqual(["0.9.0-beta"]);
  expect(body.home).toBe(root);
});

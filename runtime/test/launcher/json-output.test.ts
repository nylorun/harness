import { afterEach, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { runLauncher } from "../../src/launcher/commands.js";
import { ensureHostLayout, hostPaths } from "../../src/launcher/paths.js";
import type { LauncherEvent } from "../../src/launcher/protocol.js";
import { RUNTIME_VERSION } from "../../src/version.js";
import { removeRoot, temporaryRoot } from "./fixtures/roots.js";

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

const baselineEnv = { PATH: process.env.PATH };

function options(root: string, sink: ReturnType<typeof capture>["sink"], nodeVersion = "24.15.0") {
  return {
    home: root,
    platform: process.platform,
    nodeBinary: process.execPath,
    nodeVersion,
    baselineEnv,
    sink,
  };
}

it("E1-7: --json emits NDJSON result and errors carry remedy; exit 0/1/2", async () => {
  const root = await temporaryRoot();
  roots.push(root);

  const ok = capture();
  const code0 = await runLauncher(["--json", "version"], options(root, ok.sink));
  expect(code0).toBe(0);
  const resultLine = JSON.parse(ok.stdout.at(-1)!) as LauncherEvent;
  expect(resultLine).toEqual({
    type: "result",
    runtimeVersion: RUNTIME_VERSION,
    launcherProtocol: 1,
    protocol: HOST_PROTOCOL,
    node: "24.15.0",
  });

  const bare = capture();
  expect(await runLauncher(["--version"], options(root, bare.sink))).toBe(0);
  expect(bare.stdout.join("\n")).toContain(RUNTIME_VERSION);

  // Older Node: every lifecycle command refuses, with an install remedy.
  const old = capture();
  const code1 = await runLauncher(
    ["--json", "--home", root, "up"],
    options(root, old.sink, "22.11.0"),
  );
  expect(code1).toBe(1);
  const errorLine = JSON.parse(old.stdout.at(-1)!) as Extract<
    LauncherEvent,
    { type: "error" }
  >;
  expect(errorLine).toMatchObject({
    type: "error",
    code: "platform_unsupported",
  });
  expect(errorLine.message).toContain("22.11.0");
  expect(errorLine.remedy).toContain("npm install --global @nylorun/runtime");

  // Native Windows: refused with the WSL2 route, before anything touches the home.
  const windows = capture();
  const code3 = await runLauncher(["--json", "--home", root, "up"], {
    ...options(root, windows.sink),
    platform: "win32",
  });
  expect(code3).toBe(1);
  const windowsError = JSON.parse(windows.stdout.at(-1)!) as Extract<
    LauncherEvent,
    { type: "error" }
  >;
  expect(windowsError).toMatchObject({
    type: "error",
    code: "platform_unsupported",
  });
  expect(windowsError.remedy).toContain("WSL2");

  const usage = capture();
  const code2 = await runLauncher(
    ["--json", "install", "0.9.0"],
    options(root, usage.sink),
  );
  expect(code2).toBe(2);
  expect(usage.stderr.join("\n")).toMatch(/Unknown command|Usage/);
});

it("E1-7: status --json matches StatusResult shape", async () => {
  const root = await temporaryRoot();
  roots.push(root);
  await ensureHostLayout(hostPaths(root));
  const cap = capture();
  const code = await runLauncher(
    ["--json", "--home", root, "status"],
    options(root, cap.sink),
  );
  expect(code).toBe(0);
  const body = JSON.parse(cap.stdout.at(-1)!) as Record<string, unknown>;
  expect(body.type).toBe("result");
  expect(body.launcherProtocol).toBe(1);
  expect(body.state).toBe("absent");
  expect(body.launcherVersion).toBe(RUNTIME_VERSION);
  expect(body).not.toHaveProperty("installed");
  expect(body.home).toBe(root);
});

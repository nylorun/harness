import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/errors.js";
import { launcher } from "../../src/runtime/launcher.js";
import { runtimeVersion } from "../../src/runtime/version.js";
import { installTestRuntime, removeRoot, temporaryRoot } from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function root(prefix: string): Promise<string> {
  const dir = await temporaryRoot(prefix);
  roots.push(dir);
  return dir;
}

describe("F1-3 launcher", () => {
  it("finds the installed Runtime on PATH and returns parsed --json events", async () => {
    const version = "0.9.0-f1-launch";
    const home = await root("nylorun-cli-home-");
    const runtime = await installTestRuntime(
      await root("nylorun-cli-prefix-"),
      version,
    );

    const handle = await launcher(home, { env: runtime.env });
    expect(handle.runtime.version).toBe(version);
    expect(handle.runtime.bin).toBe(runtime.bin);
    expect(handle.runtime.node).toBe(process.versions.node);

    const outcome = await handle.invoke(["status"]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.state).toBe("absent");
    expect(outcome.result?.launcherVersion).toBe(version);
    expect(outcome.events.some((e) => e.type === "result")).toBe(true);
  });

  it("names the install command when no Runtime is on PATH, and downloads nothing", async () => {
    const home = await root("nylorun-cli-home-");
    const empty = await root("nylorun-cli-path-");
    const error = await launcher(home, {
      env: { ...process.env, PATH: empty },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).toContain(
      `npm install --global @nylorun/runtime@${runtimeVersion()}`,
    );
  });

  it("refuses a Runtime that speaks another launcher protocol", async () => {
    const home = await root("nylorun-cli-home-");
    const runtime = await installTestRuntime(
      await root("nylorun-cli-prefix-"),
      "9.0.0-future",
      {
        main: `process.stdout.write(JSON.stringify({ type: "result", runtimeVersion: "9.0.0-future", launcherProtocol: 2, protocol: { min: 3, max: 3, features: [] }, node: process.versions.node }) + "\\n");\n`,
      },
    );
    await expect(launcher(home, { env: runtime.env })).rejects.toThrow(
      /9\.0\.0-future .*not compatible[\s\S]*npm install --global @nylorun\/runtime@/,
    );
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launcher } from "../../src/runtime/launcher.js";
import {
  currentPlatformArch,
  removeRoot,
  startRegistryWithCliBuild,
  temporaryRoot,
  writeCliTestBuild,
} from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

describe("F1-3 launcher", () => {
  it("resolves an existing build and returns parsed --json events", async () => {
    const version = "0.9.0-f1-launch";
    const home = await temporaryRoot("nylorun-cli-home-");
    roots.push(home);
    await mkdir(join(home, "runtime"), { recursive: true });
    const buildPath = join(home, "runtime", version);
    await writeCliTestBuild(buildPath, {
      version,
      ...currentPlatformArch(),
    });

    const handle = await launcher(home, {
      version,
      bootstrap: async () => {
        throw new Error("bootstrap should not run when a build exists");
      },
    });
    expect(handle.build.version).toBe(version);

    const outcome = await handle.invoke(["status"]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.state).toBe("absent");
    expect(outcome.events.some((e) => e.type === "result")).toBe(true);
  });

  it("bootstraps when no build is installed, then invokes status", async () => {
    const version = "0.9.0-f1-boot-launch";
    const home = await temporaryRoot("nylorun-cli-home-");
    roots.push(home);
    const registry = await startRegistryWithCliBuild(version);

    const phases: string[] = [];
    const handle = await launcher(home, {
      version,
      registry: registry.url,
      env: { ...process.env, NYLORUN_REGISTRY: registry.url },
      onProgress: (event) => phases.push(event.phase),
    });
    expect(handle.build.version).toBe(version);
    expect(phases.length).toBeGreaterThan(0);

    const outcome = await handle.invoke(["status"]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.installed).toContain(version);

    await registry.close();
  });
});

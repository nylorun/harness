import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineEnv } from "../../src/runtime/baseline.js";

describe("F1-6 baseline moved; host sources deleted", () => {
  it("baseline lives under cli/src/runtime", () => {
    expect(
      typeof baselineEnv().PATH === "string" ||
        baselineEnv().PATH === undefined,
    ).toBe(true);
    expect(existsSync(join(process.cwd(), "src/runtime/baseline.ts"))).toBe(
      true,
    );
  });

  it("cli/src/host directory is absent", () => {
    expect(existsSync(join(process.cwd(), "src/host"))).toBe(false);
  });
});

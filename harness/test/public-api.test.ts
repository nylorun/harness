import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import manifest from "../package.json";

describe("public API", () => {
  it("exports the documented construction helpers and model adapters subpath", () => {
    expect(Object.keys(api)).toEqual(
      expect.arrayContaining([
        "run",
        "runDurable",
        "createRunState",
        "createDurableCheckpoint",
        "createExecutionState",
        "checkCompatibility",
      ]),
    );
    expect(api).not.toHaveProperty("Agent");
    expect(api).not.toHaveProperty("tool");
    expect(api).not.toHaveProperty("bindAgent");
    expect(api).not.toHaveProperty("BuiltAgent");
    expect(api).not.toHaveProperty("defineToolFamily");
    expect(manifest.exports).toHaveProperty(".");
    expect(manifest.exports).toHaveProperty("./model/adapters");
    expect(manifest.exports).toHaveProperty("./run");
    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./compatibility",
      "./model/adapters",
      "./run",
    ]);
    expect(manifest.dependencies).toEqual({ "@nylorun/core": "0.1.0-beta.1" });
  });
});

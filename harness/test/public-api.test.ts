import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import manifest from "../package.json";

describe("public API", () => {
  it("exports the documented construction helpers and model adapters subpath", () => {
    expect(Object.keys(api)).toEqual(
      expect.arrayContaining([
        "Agent",
        "AgentBuilder",
        "AgentBuildError",
        "AgentLifecycleError",
        "tool",
        "defineSchema",
        "model",
        "middleware",
      ]),
    );
    expect(api).not.toHaveProperty("bindAgent");
    expect(api).not.toHaveProperty("BuiltAgent");
    expect(api).not.toHaveProperty("defineToolFamily");
    expect(manifest.exports).toHaveProperty(".");
    expect(manifest.exports).toHaveProperty("./model/adapters");
    expect(Object.keys(manifest.exports)).toEqual([".", "./model/adapters"]);
    expect(manifest.dependencies).toBeUndefined();
  });
});

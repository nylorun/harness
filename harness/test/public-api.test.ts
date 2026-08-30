import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import manifest from "../package.json";

describe("public API", () => {
  it("exports the documented construction helpers and only the root subpath", () => {
    expect(Object.keys(api)).toEqual(
      expect.arrayContaining([
        "Agent",
        "AgentBuilder",
        "AgentBuildError",
        "AgentLifecycleError",
        "BuiltAgent",
        "tool",
        "model",
        "middleware",
      ]),
    );
    expect(api).not.toHaveProperty("bindAgent");
    expect(manifest.exports).toHaveProperty(".");
    expect(Object.keys(manifest.exports)).toEqual(["."]);
    expect(manifest.dependencies).toEqual({ "@noble/hashes": "^2.3.0" });
  });
});

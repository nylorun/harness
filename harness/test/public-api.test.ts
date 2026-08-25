import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import manifest from "../package.json";

describe("public API", () => {
  it("exports the documented construction helpers and only the root subpath", () => {
    expect(Object.keys(api)).toEqual(
      expect.arrayContaining([
        "Harness",
        "Agent",
        "AgentBuildError",
        "defineCapability",
        "defineTool",
        "defineMiddleware",
        "defineAdapter",
        "defineModel",
      ]),
    );
    expect(manifest.exports).toHaveProperty(".");
    expect(Object.keys(manifest.exports)).toEqual(["."]);
    expect(manifest).not.toHaveProperty("dependencies");
  });
});

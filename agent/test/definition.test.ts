import { describe, expect, it } from "vitest";
import { mergeAgentFolderDefinition } from "../src/definition.js";

describe("agent definition contract", () => {
  it("derives a definition from a folder without a bundler", () => {
    expect(mergeAgentFolderDefinition(
      { packageName: "reviewer", instructions: "Review changes." },
      { model: "openai/gpt-4.1" }
    )).toEqual({ name: "reviewer", instructions: "Review changes.", model: "openai/gpt-4.1" });
  });

  it("rejects ambiguous instructions consistently", () => {
    expect(() => mergeAgentFolderDefinition(
      { packageName: "reviewer", instructions: "From file." },
      { instructions: "Inline." }
    )).toThrow("NYLO_BUILD_INSTRUCTIONS_AMBIGUOUS");
  });
});

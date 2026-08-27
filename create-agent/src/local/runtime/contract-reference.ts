/** One source for the public Run contract and its generated human/machine reference. */
export const AUTHORING_REFERENCE = Object.freeze({
  generation: "0.1",
  factory: "Run(harnessFactory, options)",
  options: Object.freeze(["model", "name", "secrets", "mcp"]),
  components: Object.freeze({
    supported: ["agent.ts", "AGENT.md", "tools", "skills", "mcp"],
    reserved: ["memory", "subagents", "evals"]
  }),
  diagnostics: Object.freeze([
    "NYLO_CHECK_COMPONENT_RESERVED", "NYLO_CHECK_COMPONENT_UNKNOWN",
    "NYLO_BUILD_NAME_UNDERIVABLE", "NYLO_BUILD_INSTRUCTIONS_ABSENT", "NYLO_BUILD_INSTRUCTIONS_AMBIGUOUS"
  ])
});

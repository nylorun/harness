import { z } from "zod";
import { Run, defineTool, type RuntimeOptions } from "../../src/index.js";
import { Agent } from "@nylorun/harness";

Run((model) => Agent(model), { name: "reviewer", model: "anthropic/example", secrets: ["GITHUB_TOKEN"] });

// @ts-expect-error Limits are application middleware policy.
Run((model) => Agent(model), { name: "reviewer", model: "anthropic/example", limits: { maxTurns: 3 } });

const runtimeOptions: RuntimeOptions = {
  // @ts-expect-error Runtime hosts do not configure session limits.
  limits: { maxTurns: 3 },
};
void runtimeOptions;

// @ts-expect-error a harness selection is required
Run({}, { name: "reviewer", model: "anthropic/example" });

defineTool({
  description: "Echo text",
  input: z.object({ text: z.string() }),
  run: ({ text }) => text
});

defineTool({
  description: "Reject an invalid implementation",
  input: z.object({ text: z.string() }),
  // @ts-expect-error input is inferred from the Zod schema
  run: ({ missing }) => missing
});

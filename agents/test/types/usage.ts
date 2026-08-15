import { z } from "zod";
import { Agent, defineTool } from "../../src/index.js";

Agent({ name: "reviewer", model: "anthropic/example", secrets: ["GITHUB_TOKEN"] });

// @ts-expect-error limits are runtime scope and absent from the v0.1 authoring API
Agent({ name: "reviewer", model: "anthropic/example", limits: { turns: 3 } });

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

import { z } from "zod";
import { defineTool, type Agent } from "../../src/index.js";

defineTool({
  name: "echo",
  input: z.object({ text: z.string().trim() }),
  executeWith: "local",
  route: {},
});

defineTool({
  name: "invalid-root",
  // @ts-expect-error Harness accepts Zod object roots only.
  input: z.string(),
  executeWith: "local",
  route: {},
});

declare const agent: Agent;

// @ts-expect-error Session limits are application middleware policy.
agent.run({ limits: { maxTurns: 1 } });

// @ts-expect-error run is a Session factory; submit work through session.input
agent.run("hello");

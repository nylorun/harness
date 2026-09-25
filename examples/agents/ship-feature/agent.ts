import { Agent, Chain, Loop, Map, tool } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Composed workflow from Workflows §1: Chain → Map → Loop → tool.
 * Design: docs/design/workflows/workflows.md
 */
const planner = Agent({
  id: "planner",
  name: "Feature planner",
  description: "Breaks a feature request into implementable tasks.",
  instructions: "Plan the feature as a list of short tasks. Return { tasks: string[] }.",
  outputSchema: z.object({ tasks: z.array(z.string()) }),
}).build();

const coder = Agent({
  id: "coder",
  name: "Feature coder",
  description: "Implements one task and returns a summary.",
  instructions: "Implement the given task. Return a one-line summary of what you did.",
  outputSchema: z.object({ summary: z.string() }),
}).build();

const openPr = tool({
  name: "open-pr",
  description: "Opens a pull request from implementation summaries.",
  input: z.object({ summaries: z.array(z.string()) }),
  output: z.object({ opened: z.boolean(), count: z.number() }),
  async run({ summaries }, ctx) {
    if (!(await ctx.approve("Open the PR?"))) throw new Error("Rejected");
    return { opened: true, count: summaries.length };
  },
});

export const shipFeature = Chain({
  id: "ship-feature",
  steps: [
    planner,
    Map({
      id: "implement",
      over: (plan) => (plan as { tasks: string[] }).tasks,
      each: Loop({
        id: "code",
        run: coder,
        verify: () => ({ pass: true as const }),
        decide: ({ output }) => ({ output }),
      }),
    }),
    {
      run: openPr,
      input: ({ value }) => ({
        summaries: (value as { summary: string }[]).map((item) => item.summary),
      }),
    },
  ],
});

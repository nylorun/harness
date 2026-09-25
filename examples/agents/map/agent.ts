import { Agent, Chain, Map, tool } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Map: one run per item of a list, concurrently.
 * Design: docs/design/workflows/map.md
 */
const planner = Agent({
  id: "planner",
  name: "Section planner",
  description: "Plans sections for a digest.",
  instructions: "Plan section titles for the topic. Return { sections: string[] }.",
  outputSchema: z.object({ sections: z.array(z.string()) }),
}).build();

const sectionWriter = Agent({
  id: "section-writer",
  name: "Section writer",
  description: "Writes one section from a title.",
  instructions: "Write one short section for the given title.",
}).build();

const merge = tool({
  name: "merge",
  description: "Joins section texts into one digest.",
  input: z.object({ parts: z.array(z.string()) }),
  output: z.object({ digest: z.string() }),
  async run({ parts }) {
    return { digest: parts.join("\n\n") };
  },
});

export const digest = Chain({
  id: "digest",
  steps: [
    planner,
    Map({
      id: "write",
      over: (plan) => (plan as { sections: string[] }).sections,
      each: sectionWriter,
    }),
    {
      run: merge,
      input: ({ value }) => ({ parts: value as string[] }),
    },
  ],
});
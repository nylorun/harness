import { Agent, Chain, tool } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Chain: steps in order. Each step's output is the next step's input.
 * Design: docs/design/workflows/chain.md
 */
const researcher = Agent({
  id: "researcher",
  name: "Researcher",
  description: "Gathers findings for a topic. Returns a short findings string.",
  instructions: "Research the given topic. Reply with concise findings only.",
  outputSchema: z.object({ findings: z.string() }),
}).build();

const analyst = Agent({
  id: "analyst",
  name: "Analyst",
  description: "Summarizes research findings.",
  instructions: "Turn findings into a one-paragraph summary.",
  outputSchema: z.object({ summary: z.string() }),
}).build();

const publish = tool({
  name: "publish",
  description: "Records a finished summary.",
  input: z.object({ summary: z.string() }),
  output: z.object({ published: z.boolean(), summary: z.string() }),
  async run({ summary }) {
    return { published: true, summary };
  },
});

export const report = Chain({
  id: "report",
  steps: [
    researcher,
    {
      run: analyst,
      input: ({ results }) =>
        `Summarize these findings:\n${(results as { researcher: { findings: string } }).researcher.findings}`,
    },
    {
      run: publish,
      input: ({ value }) => ({
        summary: (value as { summary: string }).summary,
      }),
    },
  ],
});

import { Agent, Chain, Parallel } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Parallel: a fixed set of named branches at the same time, same input.
 * Design: docs/design/workflows/parallel.md
 */
const securityReviewer = Agent({
  id: "security-reviewer",
  name: "Security reviewer",
  description: "Reviews a change for security issues.",
  instructions: "Review for security. Return a short finding.",
  outputSchema: z.object({ finding: z.string() }),
}).build();

const styleReviewer = Agent({
  id: "style-reviewer",
  name: "Style reviewer",
  description: "Reviews a change for style.",
  instructions: "Review for style. Return a short finding.",
  outputSchema: z.object({ finding: z.string() }),
}).build();

const testAuditor = Agent({
  id: "test-auditor",
  name: "Test auditor",
  description: "Reviews a change for test coverage.",
  instructions: "Review tests. Return a short finding.",
  outputSchema: z.object({ finding: z.string() }),
}).build();

const summarizer = Agent({
  id: "summarizer",
  name: "Summarizer",
  description: "Merges parallel review findings.",
  instructions: "Combine the review findings into one short summary.",
}).build();

export const prReview = Chain({
  id: "pr-review",
  steps: [
    Parallel({
      id: "review",
      branches: {
        security: securityReviewer,
        style: styleReviewer,
        tests: testAuditor,
      },
    }),
    {
      run: summarizer,
      input: ({ value }) =>
        `Summarize these reviews:\n${JSON.stringify(value, null, 2)}`,
    },
  ],
});

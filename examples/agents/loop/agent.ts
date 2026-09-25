import { Agent, Loop } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Loop: run, verify, decide whether to go again.
 * Design: docs/design/workflows/loops.md
 */
const coder = Agent({
  id: "coder",
  name: "Coder",
  description: "Produces a short answer that should satisfy a check.",
  instructions: "Answer the task. Prefer one clear sentence.",
  outputSchema: z.object({ answer: z.string() }),
}).build();

export const polish = Loop({
  id: "polish",
  run: coder,
  verify: ({ output }) => {
    const text = (output as { answer?: string } | undefined)?.answer ?? "";
    if (text.trim().length >= 8) return { pass: true as const };
    return {
      pass: false as const,
      feedback: "Answer must be at least eight characters. Try again.",
    };
  },
  decide: ({ output, verdict, iteration }) => {
    if (verdict.pass) return { output };
    if (iteration >= 3) throw new Error("Still too short after 3 tries");
    return { input: verdict.feedback };
  },
});

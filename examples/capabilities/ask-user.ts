import { tool } from "@nylorun/harness";
import { z } from "zod";

export const askUser = {
  id: "ask-user",
  instructions: ["Use ask_user when you need a short fact from the human before continuing."],
  tools: [
    tool({
      name: "ask_user",
      description: "Ask the human a question and wait for their reply.",
      inputSchema: z.object({ question: z.string().min(1).max(500) }),
      async execute({ question }, context) {
        if (context.resume?.kind === "response") {
          return { kind: "completed" as const, output: { answer: context.resume.value ?? null } };
        }
        return {
          kind: "interaction-required" as const,
          interaction: { kind: "response" as const, prompt: question },
        };
      },
    }),
  ],
} as const;

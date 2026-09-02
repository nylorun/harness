import { tool, type BuiltAgent } from "@nylorun/harness";
import { z } from "zod";

export function delegateTo(agents: Readonly<Record<string, BuiltAgent>>) {
  const names = Object.keys(agents);
  return {
    id: "subagents",
    instructions: [
      `Delegate work with the delegate tool. Available specialists: ${names.join(", ")}.`,
    ],
    tools: [
      tool({
        name: "delegate",
        description: `Run a specialist subagent to completion and return its final answer. Specialists: ${names.join(", ")}.`,
        parameters: z.object({
          name: z.string(),
          task: z.string().min(1).max(2_000),
        }),
        async execute({ name, task }, context) {
          const child = agents[name];
          if (child === undefined) {
            return {
              kind: "failed" as const,
              code: "subagent.unknown",
              message: `Unknown specialist '${name}'.`,
            };
          }
          const session = child.run({ id: `sub-${context.callId}` });
          try {
            const completion = await session.input(task, { signal: context.signal }).completed;
            if (completion.status !== "completed") {
              return {
                kind: "failed" as const,
                code: "subagent.incomplete",
                message: `Specialist '${name}' ended with status ${completion.status}.`,
              };
            }
            const final = completion.events.find((event) => event.type === "final");
            if (final === undefined || final.type !== "final") {
              return {
                kind: "failed" as const,
                code: "subagent.no-final",
                message: `Specialist '${name}' did not return a final answer.`,
              };
            }
            return {
              kind: "completed" as const,
              output: { specialist: name, answer: final.output },
            };
          } catch (error) {
            return {
              kind: "failed" as const,
              code: "subagent.failed",
              message: error instanceof Error ? error.message : "Specialist failed.",
            };
          } finally {
            await session.stop();
          }
        },
      }),
    ],
  } as const;
}

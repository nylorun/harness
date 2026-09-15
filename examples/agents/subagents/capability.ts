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
        inputSchema: z.object({
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
          if (!context.onModelCall) {
            return {
              kind: "failed" as const,
              code: "subagent.no-model",
              message: "The parent session did not provide a model callable.",
            };
          }
          try {
            const completion = await child.run({ input: task, onModelCall: context.onModelCall, signal: context.signal, scope: context.scope });
            if (completion.status !== "completed") return { kind: "failed" as const, code: "subagent.incomplete", message: `Specialist '${name}' ended with status ${completion.status}.` };
            return { kind: "completed" as const, output: { specialist: name, answer: completion.output } };
          } catch (error) {
            return {
              kind: "failed" as const,
              code: "subagent.failed",
              message:
                error instanceof Error ? error.message : "Specialist failed.",
            };
          }
        },
      }),
    ],
  } as const;
}

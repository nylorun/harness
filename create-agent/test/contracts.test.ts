import { z } from "zod";
import { tool, Agent, type BuiltAgent, type ModelAdapter } from "@nylorun/core/define";
import type { RuntimeAgent } from "@nylorun/runtime";
import { piModel } from "@nylorun/runtime/node";
import { agentContract } from "../../runtime/test/contract-suite.js";

// These assignments must compile without assertions; Runtime depends on canonical Harness types.
const adapter: ModelAdapter = piModel();
const built: BuiltAgent = Agent({ id: "configured", name: "Configured" }).build();
const portable: RuntimeAgent = built;
void portable;
void adapter;
agentContract(
  "Harness",
  (kind) => {
    let builder = Agent({ id: "echo", name: "Echo" });
    if (kind)
      builder = builder.use({
        id: "interaction",
        tools: [
          tool({
            name: "ask",
            inputSchema: z.object({}),
            execute: async (_input, context) =>
              context.resume
                ? { kind: "completed", output: "ok" }
                : {
                    kind: "interaction-required",
                    interaction: { kind, prompt: "confirm" },
                  },
          }),
        ],
      });
    return builder.build();
  },
  (kind) => async (call) =>
    kind && !call.prompt.some((item) => item.kind === "tool-result")
      ? {
          output: [{ type: "tool-call", id: "ask", name: "ask", args: {} }],
          finishReason: "tool-calls",
        }
      : "hello",
);

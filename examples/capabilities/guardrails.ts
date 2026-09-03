import { middleware, tool } from "@nylorun/harness";
import { z } from "zod";

const blocked = /secret|password|credential|api[_-]?key/iu;
const jailbreak = /ignore (all )?guards|jailbreak/iu;
const override = /override-policy/iu;

function arrivalText(event: { readonly kind: string; readonly text?: string }): string {
  return event.kind === "user-message" || event.kind === "interrupt" ? (event.text ?? "") : "";
}

function publishText(args: unknown): string {
  if (args !== null && typeof args === "object" && "text" in args) {
    return typeof args.text === "string" ? args.text : "";
  }
  return "";
}

function candidateText(
  candidate: { readonly output: readonly { readonly type: string; readonly text?: string }[] } | undefined,
): string {
  if (!candidate) return "";
  return candidate.output
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function looksSecret(value: unknown): boolean {
  return blocked.test(typeof value === "string" ? value : JSON.stringify(value));
}

/** Policy lives in middleware. The publish tool itself does not authorize or reject content. */
export const publish = {
  id: "publish",
  instructions: [
    "Use publish for a short public notice. Secrets are denied. Text that asks to override-policy trips a hard stop.",
  ],
  tools: [
    tool({
      name: "publish",
      description: "Publish a short public notice after policy review.",
      inputSchema: z.object({ text: z.string().min(1).max(500) }),
      async execute({ text }) {
        return { kind: "completed" as const, output: { published: text } };
      },
    }),
  ],
} as const;

/** Policy lives in middleware. Lookup returns records as stored; it does not filter them. */
export const lookup = {
  id: "lookup",
  instructions: ["Use lookup for a named record: status or vault."],
  tools: [
    tool({
      name: "lookup",
      description: "Look up a named record. status is public. vault may contain secrets.",
      inputSchema: z.object({ record: z.enum(["status", "vault"]) }),
      async execute({ record }) {
        return {
          kind: "completed" as const,
          output:
            record === "vault"
              ? { record, value: "api_key=sk-demo-not-real" }
              : { record, value: "operational" },
        };
      },
    }),
  ],
} as const;

/** Input guardrail: jailbreak phrasing in user text stops the run before the model. */
export const inputGuardrail = middleware(async (request, next) => {
  for (const event of request.arrivals) {
    if (jailbreak.test(arrivalText(event))) {
      return request.tripwire({
        code: "input.blocked",
        message: "User input requested a policy override.",
        scope: "session",
      });
    }
  }
  return next();
});

/** Output guardrail: secret-looking assistant text is rejected after the model step. */
export const outputGuardrail = middleware(async (_request, next) => {
  const response = await next();
  if (looksSecret(candidateText(response.candidate()))) {
    return response.tripwire({
      code: "output.blocked",
      message: "Assistant output looks like a secret and was blocked.",
      scope: "session",
    });
  }
  return response;
});

/** Tool-input guardrail: inspect publish arguments before the tool executes. */
export const toolInputGuardrail = middleware(async (_request, next) => {
  const response = await next();
  for (const call of response.toolCalls()) {
    if (call.name !== "publish") continue;
    const text = publishText(call.args);
    if (override.test(text)) {
      return response.tripwire({
        code: "policy.blocked",
        message: "Publish text requested a policy override.",
        scope: "session",
      });
    }
    if (looksSecret(text)) {
      response.deny(call.id, "Publish text looks like a secret and was blocked.");
    }
  }
  return response;
});

/** Tool-output guardrail: secret-looking tool results stop the next model step. */
export const toolOutputGuardrail = middleware(async (request, next) => {
  for (const result of request.toolResults) {
    if (result.kind === "completed" && looksSecret(result.output)) {
      return request.tripwire({
        code: "tool-output.blocked",
        message: "Tool output looks like a secret and was blocked.",
        scope: "session",
      });
    }
  }
  return next();
});

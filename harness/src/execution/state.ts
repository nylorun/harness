import { z } from "zod";
import { HarnessError } from "../errors.js";
import { assertJson, copyJson } from "../utils/immutable.js";
import { createId } from "../utils/ids.js";
import { validateTranscript } from "../execution/transcript.js";
import type { BuiltAgent } from "../build/agent.js";
import type { ExecutionInput, ExecutionState } from "../types/execution.js";
import type { InputEvent } from "../types/transcript.js";

const id = z.string().min(1);
const json = z.unknown().refine((value) => {
  try {
    assertJson(value);
    return true;
  } catch {
    return false;
  }
}, "Expected JSON data");
const interaction = z
  .object({
    id,
    kind: z.enum(["approval", "response"]),
    prompt: z.string(),
    metadata: json.optional(),
  })
  .strict();
const outcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), output: json }).strict(),
  z.object({ kind: z.literal("denied"), reason: z.string() }).strict(),
  z.object({ kind: z.literal("failed"), code: id, message: z.string() }).strict(),
]);
const reference = z
  .object({
    capabilityId: id,
    toolName: id.optional(),
    familyId: id.optional(),
    version: id.optional(),
    binding: json.optional(),
    descriptor: z
      .object({
        name: id,
        description: z.string().optional(),
        inputSchema: z.record(z.string(), json),
        outputSchema: z.record(z.string(), json).optional(),
      })
      .strict(),
  })
  .strict();
const call = z
  .object({
    callId: id,
    invocationId: id,
    toolName: id,
    args: json,
    rawArgs: json,
    reference,
    status: z.enum(["pending", "active", "settled", "interaction", "deferred"]),
    result: json.optional(),
    interaction: interaction.optional(),
    interactionPhase: z.enum(["before", "execute"]).optional(),
    resume: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("approval"),
            interactionId: id,
            approved: z.boolean(),
            token: json.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("response"),
            interactionId: id,
            value: json,
            token: json.optional(),
          })
          .strict(),
      ])
      .optional(),
    token: json.optional(),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    agentId: id,
    executionVersion: id,
    executionId: id,
    outputContract: z.record(z.string(), json).optional(),
    revision: z.number().int().nonnegative(),
    turnCount: z.number().int().nonnegative(),
    transcript: z.array(json),
    status: z.enum(["ready", "active", "completed", "paused", "cancelled", "failed"]),
    plan: z
      .object({
        turnId: id,
        stepId: id,
        stepNumber: z.number().int().positive(),
        order: z.array(z.object({ callId: id, toolName: id }).strict()),
        immediate: z.array(json),
        calls: z.array(call),
      })
      .strict()
      .optional(),
  })
  .strict();

export function createExecutionState(
  agent: Pick<BuiltAgent, "id" | "executionVersion" | "output">,
): ExecutionState {
  return copyJson({
    version: 1,
    agentId: agent.id,
    executionVersion: agent.executionVersion,
    executionId: createId("execution"),
    revision: 0,
    turnCount: 0,
    transcript: [],
    status: "ready",
    ...(agent.output ? { outputContract: agent.output.schema.jsonSchema } : {}),
  });
}

export function validateExecutionState(value: unknown): ExecutionState {
  try {
    assertJson(value);
    const parsed = schema.parse(value) as unknown as ExecutionState;
    validateTranscript(parsed.transcript);
    const plan = parsed.plan;
    if (parsed.status === "paused" && !plan)
      throw new HarnessError("execution.invalid-state", "Paused execution requires a pending plan");
    if (plan) {
      const ids = new Set<string>();
      const invocations = new Set<string>();
      const interactions = new Set<string>();
      const ordered = new Set(plan.order.map((item) => item.callId));
      if (
        ordered.size !== plan.order.length ||
        plan.order.length !== plan.calls.length + plan.immediate.length
      )
        throw new HarnessError(
          "execution.invalid-state",
          "Plan order must identify every result exactly once",
        );
      for (const result of plan.immediate) {
        if (
          ids.has(result.callId) ||
          !plan.order.some(
            (item) => item.callId === result.callId && item.toolName === result.toolName,
          )
        )
          throw new HarnessError("execution.invalid-state", "Invalid immediate result identity");
        ids.add(result.callId);
      }
      for (const item of plan.calls) {
        if (ids.has(item.callId) || invocations.has(item.invocationId))
          throw new HarnessError("execution.invalid-state", "Duplicate pending call identity");
        ids.add(item.callId);
        invocations.add(item.invocationId);
        if (
          !plan.order.some(
            (order) => order.callId === item.callId && order.toolName === item.toolName,
          )
        )
          throw new HarnessError("execution.invalid-state", "Pending call missing from plan order");
        if (item.toolName !== item.reference.descriptor.name)
          throw new HarnessError(
            "execution.invalid-state",
            "Pending tool name differs from its contract",
          );
        if ((item.reference.toolName === undefined) === (item.reference.familyId === undefined))
          throw new HarnessError(
            "execution.invalid-state",
            "Tool reference must select exactly one definition",
          );
        if (item.interaction) {
          if (interactions.has(item.interaction.id))
            throw new HarnessError("execution.invalid-state", "Duplicate interaction identity");
          interactions.add(item.interaction.id);
        }
        if (item.status !== "settled" && item.result)
          throw new HarnessError(
            "execution.invalid-state",
            "Unsettled call cannot contain a result",
          );
        if (item.status === "settled" && !item.result)
          throw new HarnessError("execution.invalid-state", "Settled call requires a result");
        if (item.status === "interaction" && (!item.interaction || !item.interactionPhase))
          throw new HarnessError("execution.invalid-state", "Missing interaction state");
        if (
          item.result &&
          (item.result.callId !== item.callId || item.result.toolName !== item.toolName)
        )
          throw new HarnessError("execution.invalid-state", "Result identity mismatch");
      }
      validateTranscript([
        {
          kind: "tool-results",
          turnId: plan.turnId,
          stepId: plan.stepId,
          results: [
            ...plan.immediate,
            ...plan.calls.flatMap((item) => (item.result ? [item.result] : [])),
          ],
        },
      ]);
      if (
        parsed.status === "paused" &&
        (plan.calls.some((item) => item.status === "active") ||
          !plan.calls.some((item) => item.status === "interaction" || item.status === "deferred"))
      )
        throw new HarnessError("execution.invalid-state", "Invalid paused plan");
    }
    return copyJson(parsed);
  } catch (cause) {
    throw new HarnessError(
      "execution.invalid-state",
      `Invalid execution state: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

export function normalizeInput(
  value: ExecutionInput,
): InputEvent | Extract<ExecutionInput, { kind: "continue" | "settle" }> {
  try {
    if (typeof value === "string") return { kind: "user-message", text: value };
    assertJson(value);
    if ("kind" in value && value.kind === "continue")
      return z
        .object({ kind: z.literal("continue") })
        .strict()
        .parse(value);
    if ("kind" in value && value.kind === "settle")
      return z
        .object({ kind: z.literal("settle"), invocationId: id, outcome })
        .strict()
        .parse(value) as Extract<ExecutionInput, { kind: "settle" }>;
    const event = "kind" in value ? value : { kind: "user-message", ...value };
    const validated = validateTranscript([
      { kind: "input", turnId: "validation", event: event as InputEvent },
    ]);
    return (validated[0] as Extract<(typeof validated)[number], { kind: "input" }>).event;
  } catch (cause) {
    throw new HarnessError(
      "execution.invalid-input",
      `Invalid input: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

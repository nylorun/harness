import { HarnessError, isHarnessError } from "../errors.js";
import type { ToolOutcome, ToolResult } from "../types/tool.js";
import { createId } from "../utils/ids.js";
import { copyJson } from "../utils/immutable.js";
import type { Invocation } from "./invocation.js";
import { toolResult } from "./tool-result.js";

export async function dispatchPlan(invocation: Invocation): Promise<"paused" | undefined> {
  const { signal, definitions, options, observe, record } = invocation;
  let plan = invocation.state.plan!;
  if (
    plan.calls.some((call) => call.status === "interaction" && call.interactionPhase === "before")
  ) {
    for (const call of plan.calls)
      if (call.status === "interaction")
        observe({
          type: "interaction.required",
          turnId: plan.turnId,
          stepId: plan.stepId,
          interactionId: call.interaction!.id,
          kind: call.interaction!.kind,
          callId: call.callId,
          toolName: call.toolName,
          phase: "interaction",
          attributes: {
            prompt: call.interaction!.prompt,
            ...(call.interaction!.metadata ? { metadata: call.interaction!.metadata } : {}),
          },
        });
    return "paused";
  }
  signal.throwIfAborted();
  const pending = plan.calls.filter((call) => call.status === "pending");
  if (pending.length) {
    invocation.state = {
      ...invocation.state,
      plan: {
        ...plan,
        calls: plan.calls.map((call) =>
          call.status === "pending" ? { ...call, status: "active" } : call,
        ),
      },
    };
    await record();
    signal.throwIfAborted();
    const settled = await Promise.all(
      pending.map(async (call) => {
        const definition = definitions.get(call.invocationId)!;
        const eventIds = {
          executionId: invocation.state.executionId,
          turnId: plan.turnId,
          stepId: plan.stepId,
          callId: call.callId,
          invocationId: call.invocationId,
          toolName: call.toolName,
          middlewareId: call.reference.capabilityId,
          slot: definition.owner.slot,
        };
        observe({ type: "tool.started", ...eventIds, attributes: { args: call.args } });
        let outcome: ToolOutcome;
        try {
          signal.throwIfAborted();
          outcome = await definition.execute(call.args, {
            executionId: invocation.state.executionId,
            turnId: plan.turnId,
            stepId: plan.stepId,
            callId: call.callId,
            invocationId: call.invocationId,
            signal,
            info: options.info,
            onModelCall: options.onModelCall,
            ...(call.resume ? { resume: call.resume } : {}),
          });
          if (!outcome || typeof outcome !== "object")
            throw new HarnessError("tool.invalid-tool-result", "Tool returned an invalid outcome");
          if (outcome.kind === "interaction-required") {
            if (
              !["approval", "response"].includes(outcome.interaction.kind) ||
              typeof outcome.interaction.prompt !== "string"
            )
              throw new HarnessError(
                "tool.invalid-tool-result",
                "Tool returned an invalid interaction",
              );
            return copyJson({
              ...call,
              status: "interaction" as const,
              interaction: {
                ...outcome.interaction,
                id: outcome.interaction.id ?? createId("interaction"),
              },
              interactionPhase: "execute" as const,
              ...(outcome.token === undefined ? {} : { token: outcome.token }),
            });
          }
          if (outcome.kind === "deferred") {
            observe({
              type: "tool.deferred",
              ...eventIds,
              attributes: outcome.token === undefined ? {} : { token: outcome.token },
            });
            return copyJson({
              ...call,
              status: "deferred" as const,
              ...(outcome.token === undefined ? {} : { token: outcome.token }),
            });
          }
          const result = toolResult(call, definition, outcome);
          observe({
            type: "tool.completed",
            ...eventIds,
            outcome: result.kind,
            attributes: result,
          });
          return copyJson({ ...call, status: "settled" as const, result });
        } catch (cause) {
          const result: ToolResult = {
            callId: call.callId,
            toolName: call.toolName,
            kind: "failed",
            code: signal.aborted
              ? "tool.cancelled"
              : isHarnessError(cause)
                ? cause.code
                : "tool.execution-failed",
            message: cause instanceof Error ? cause.message : String(cause),
          };
          observe({
            type: "tool.completed",
            ...eventIds,
            outcome: result.kind,
            attributes: result,
          });
          return copyJson({ ...call, status: "settled" as const, result });
        }
      }),
    );
    const byId = new Map(settled.map((call) => [call.invocationId, call]));
    plan = { ...plan, calls: plan.calls.map((call) => byId.get(call.invocationId) ?? call) };
    invocation.state = { ...invocation.state, plan };
    await record();
  }
  signal.throwIfAborted();
  if (plan.calls.some((call) => call.status === "interaction" || call.status === "deferred")) {
    for (const call of plan.calls)
      if (call.status === "interaction")
        observe({
          type: "interaction.required",
          turnId: plan.turnId,
          stepId: plan.stepId,
          interactionId: call.interaction!.id,
          kind: call.interaction!.kind,
          callId: call.callId,
          toolName: call.toolName,
          phase: call.interactionPhase === "before" ? "interaction" : "execute",
          attributes: {
            prompt: call.interaction!.prompt,
            ...(call.interaction!.metadata ? { metadata: call.interaction!.metadata } : {}),
          },
        });
    return "paused";
  }
  const results = [
    ...plan.immediate,
    ...plan.calls.flatMap((call) => (call.result ? [call.result] : [])),
  ];
  const ordered = plan.order.map((item) =>
    results.find((result) => result.callId === item.callId && result.toolName === item.toolName)!,
  );
  const { plan: _, ...rest } = invocation.state;
  invocation.state = {
    ...rest,
    transcript: [
      ...invocation.state.transcript,
      { kind: "tool-results", turnId: plan.turnId, stepId: plan.stepId, results: ordered },
    ],
  };
  await record();
}

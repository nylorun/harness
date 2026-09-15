import type { BuiltAgent } from "../build/agent.js";
import { canonical } from "../build/registry.js";
import { HarnessError, isHarnessError } from "../errors.js";
import { runStep } from "../step/run.js";
import type {
  ExecutionEvent,
  ExecutionPlan,
  ExecutionState,
  RunOptions,
  RunResult,
  SavedToolCall,
} from "../types/execution.js";
import type { InputEvent, ExecutionSnapshot } from "../types/transcript.js";
import type { JsonValue, ObserveEvent, Tripwire } from "../types/shared.js";
import type { BoundToolDefinition, ToolOutcome, ToolResult } from "../types/tool.js";
import { copyJson } from "../utils/immutable.js";
import { createId } from "../utils/ids.js";
import { createExecutionState, normalizeInput, validateExecutionState } from "./state.js";

/** All mutable progress belongs to this invocation and is discarded when it settles. */
export async function execute(
  agent: BuiltAgent<any, any>,
  options: RunOptions<any>,
): Promise<RunResult<JsonValue>> {
  if (!options || typeof options.onModelCall !== "function")
    throw new HarnessError("execution.invalid-input", "run() requires input and onModelCall");
  const acceptedOptions = new Set([
    "state",
    "input",
    "onModelCall",
    "scope",
    "signal",
    "onEvent",
    "record",
  ]);
  for (const key of Object.keys(options))
    if (!acceptedOptions.has(key))
      throw new HarnessError("execution.invalid-input", `Unknown run option '${key}'`);
  for (const key of ["record", "onEvent"] as const)
    if (options[key] !== undefined && typeof options[key] !== "function")
      throw new HarnessError("execution.invalid-input", `${key} must be a function`);
  if (
    options.signal !== undefined &&
    (!options.signal ||
      typeof options.signal.throwIfAborted !== "function" ||
      typeof options.signal.addEventListener !== "function")
  )
    throw new HarnessError("execution.invalid-input", "signal must be an AbortSignal");
  let state =
    options.state === undefined
      ? createExecutionState(agent)
      : validateExecutionState(options.state);
  if (
    state.agentId !== agent.id ||
    state.executionVersion !== agent.executionVersion ||
    canonical(state.outputContract) !== canonical(agent.output?.schema.jsonSchema)
  )
    throw new HarnessError(
      "execution.incompatible",
      "Saved state requires the original compatible agent, executionVersion, and outputSchema",
    );
  if (
    (state.status !== "paused" && state.plan !== undefined) ||
    state.status === "active" ||
    state.plan?.calls.some((call) => call.status === "active")
  )
    throw new HarnessError(
      "execution.invalid-state",
      "Execution was interrupted with possibly active effects. Reconcile it before starting another run; automatic replay is not supported.",
    );
  const input = normalizeInput(options.input);
  const definitions = new Map<string, BoundToolDefinition>();
  for (const call of state.plan?.calls ?? []) {
    const definition = agent.registry.restore(call.reference);
    const validation = definition.inputSchema.validate(call.rawArgs);
    if (!validation.ok || canonical(validation.value) !== canonical(call.args))
      throw new HarnessError(
        "execution.incompatible",
        "Saved tool arguments differ from their accepted contract",
      );
    definitions.set(call.invocationId, definition);
  }
  if (state.status === "paused" && !(input.kind === "continue" && options.signal?.aborted)) {
    state = applyResume(state, input, definitions);
    if (input.kind === "approve" || input.kind === "respond")
      state = {
        ...state,
        transcript: [
          ...state.transcript,
          { kind: "input", turnId: state.plan!.turnId, event: input },
        ],
      };
  } else if (input.kind === "approve" || input.kind === "respond" || input.kind === "settle") {
    throw new HarnessError(
      "execution.invalid-input",
      "There is no matching paused operation for this input",
    );
  }
  const signal = options.signal ?? new AbortController().signal;
  let sequence = 0;
  const runId = createId("run");
  let reportingFailure = false;
  const observe = (source: ObserveEvent | (() => ObserveEvent)) =>
    emit(typeof source === "function" ? source() : source);
  const emit = (
    event:
      | ObserveEvent
      | {
          type:
            | "execution.completed"
            | "execution.paused"
            | "execution.cancelled"
            | "execution.failed"
            | "observation.failed";
          attributes?: Record<string, JsonValue>;
        },
  ) => {
    if (!options.onEvent) return;
    const value = copyJson({
      ...event,
      executionId: state.executionId,
      runId,
      sequence: ++sequence,
    }) as ExecutionEvent;
    const failed = () => {
      if (reportingFailure || event.type === "observation.failed") return;
      reportingFailure = true;
      emit({
        type: "observation.failed",
        attributes: { message: "Execution observer failed; execution is continuing" },
      });
      reportingFailure = false;
    };
    try {
      const result = options.onEvent(value);
      if (result) void Promise.resolve(result).catch(failed);
    } catch {
      failed();
    }
  };
  const record = async () => {
    state = copyJson({ ...state, revision: state.revision + 1 });
    if (!options.record) return;
    try {
      await options.record(copyJson(state));
    } catch (cause) {
      throw new HarnessError(
        "execution.record-failed",
        "Recording failed. Execution stopped; reconcile any external effects before retrying.",
        { cause },
      );
    }
  };
  const finish = async (
    result:
      | Omit<Extract<RunResult<JsonValue>, { status: "completed" }>, "state">
      | { status: "paused" }
      | { status: "cancelled" }
      | { status: "failed"; error: Tripwire },
  ): Promise<RunResult<JsonValue>> => {
    if (result.status === "cancelled" && state.plan) {
      const plan = state.plan;
      const results = [
        ...plan.immediate,
        ...plan.calls.map(
          (call) =>
            call.result ?? {
              kind: "failed" as const,
              callId: call.callId,
              toolName: call.toolName,
              code: "tool.cancelled",
              message: "Invocation cancelled; external effects are not automatically retried",
            },
        ),
      ];
      const { plan: _, ...rest } = state;
      state = {
        ...rest,
        cancelledCalls: [
          ...(rest.cancelledCalls ?? []),
          ...plan.calls.filter((call) => !call.result),
        ],
        transcript: [
          ...state.transcript,
          {
            kind: "tool-results",
            turnId: plan.turnId,
            stepId: plan.stepId,
            results: plan.order.map((item) =>
              results.find(
                (result) => result.callId === item.callId && result.toolName === item.toolName,
              )!,
            ),
          },
        ],
      };
    }
    state = { ...state, status: result.status };
    await record();
    emit({
      type: `execution.${result.status}`,
      ...(result.status === "completed"
        ? { attributes: { output: result.output } }
        : result.status === "failed"
          ? { attributes: { error: result.error as unknown as JsonValue } }
          : {}),
    });
    if (result.status === "paused")
      return {
        status: "paused",
        state,
        pending: state.plan!.calls.filter(
          (call) => call.status === "interaction" || call.status === "deferred",
        ),
      };
    return { ...result, state };
  };

  try {
    signal.throwIfAborted();
    let turnId: string;
    let stepNumber: number;
    let arrivals: readonly InputEvent[] = [];
    let toolResults: readonly ToolResult[] = [];
    if (state.plan) {
      turnId = state.plan.turnId;
      stepNumber = state.plan.stepNumber + 1;
      state = { ...state, status: "active" };
      await record();
      const result = await dispatchPlan();
      if (result) return result;
      toolResults = lastResults(state);
    } else {
      turnId = createId("turn");
      stepNumber = 1;
      if (input.kind !== "continue" && input.kind !== "settle") arrivals = [input];
      state = {
        ...state,
        status: "active",
        turnCount: state.turnCount + 1,
        transcript: [
          ...state.transcript,
          ...arrivals.map((event) => ({ kind: "input" as const, turnId, event })),
        ],
      };
      await record();
    }
    for (; ; stepNumber++) {
      signal.throwIfAborted();
      const stepId = createId("step");
      const snapshot: ExecutionSnapshot = {
        id: state.executionId,
        status: "running",
        revision: state.revision,
        turnCount: state.turnCount,
        transcript: state.transcript,
      };
      const result = await runStep({
        agent: {
          middleware: agent.middleware,
          invoke: options.onModelCall,
          registry: agent.registry,
        },
        state: snapshot,
        executionId: state.executionId,
        turnId,
        stepId,
        turnNumber: state.turnCount,
        stepNumber,
        arrivals,
        toolResults,
        signal,
        scope: options.scope,
        observe,
        output: agent.output,
      });
      signal.throwIfAborted();
      if (result.candidate) {
        state = {
          ...state,
          transcript: [
            ...state.transcript,
            { kind: "candidate", turnId, stepId, candidate: result.candidate },
          ],
        };
        observe({
          type: "model.completed",
          turnId,
          stepId,
          ...(result.modelInvocationId ? { invocationId: result.modelInvocationId } : {}),
          ...(result.requestedModelId === undefined
            ? {}
            : { requestedModelId: result.requestedModelId }),
          attributes: result.candidate,
        });
      }
      if (result.output.kind === "tripwire") {
        observe({
          type: "tripwire",
          turnId,
          stepId,
          code: result.output.tripwire.code,
          scope: result.output.tripwire.scope ?? "step",
          attributes: { message: result.output.tripwire.message },
        });
        return finish({ status: "failed", error: result.output.tripwire });
      }
      if (result.output.kind === "final") {
        state = {
          ...state,
          transcript: [
            ...state.transcript,
            { kind: "final", turnId, stepId, output: result.output.output },
          ],
        };
        observe({
          type: "turn.completed",
          turnId,
          stepId,
          attributes: { output: result.output.output },
        });
        return finish({ status: "completed", output: result.output.output });
      }
      const plan = result.output.plan;
      const calls: SavedToolCall[] = plan.executable.map((entry) => {
        const reference = agent.registry.reference(entry.definition);
        definitions.set(entry.invocationId, agent.registry.restore(reference));
        return {
          callId: entry.call.callId,
          toolName: entry.call.toolName,
          args: entry.call.args,
          rawArgs: entry.rawArgs,
          invocationId: entry.invocationId,
          reference,
          status: entry.interaction ? "interaction" : "pending",
          ...(entry.interaction
            ? { interaction: entry.interaction, interactionPhase: "before" as const }
            : {}),
        };
      });
      state = {
        ...state,
        plan: {
          turnId,
          stepId,
          stepNumber,
          order: plan.order,
          immediate: plan.immediateResults,
          calls,
        },
      };
      observe({
        type: "tool.sealed",
        turnId,
        stepId,
        attributes: {
          executable: plan.executable.map((entry) => ({
            callId: entry.call.callId,
            toolName: entry.call.toolName,
            args: entry.call.args,
            rawArgs: entry.rawArgs,
            invocationId: entry.invocationId,
            owner: entry.owner,
            ...(entry.interaction ? { interaction: entry.interaction } : {}),
          })),
          immediate: plan.immediateResults,
        },
      });
      await record();
      const stopped = await dispatchPlan();
      if (stopped) return stopped;
      toolResults = lastResults(state);
      arrivals = [];
    }
  } catch (error) {
    if (isHarnessError(error) && error.code === "execution.record-failed") throw error;
    if (signal.aborted) return finish({ status: "cancelled" });
    return finish({
      status: "failed",
      error: {
        code: isHarnessError(error) ? error.code : "execution.failed",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  async function dispatchPlan(): Promise<RunResult<JsonValue> | undefined> {
    let plan = state.plan!;
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
      return finish({ status: "paused" });
    }
    signal.throwIfAborted();
    const pending = plan.calls.filter((call) => call.status === "pending");
    if (pending.length) {
      state = {
        ...state,
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
            executionId: state.executionId,
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
              executionId: state.executionId,
              turnId: plan.turnId,
              stepId: plan.stepId,
              callId: call.callId,
              invocationId: call.invocationId,
              signal,
              scope: options.scope,
              onModelCall: options.onModelCall,
              ...(call.resume ? { resume: call.resume } : {}),
            });
            if (!outcome || typeof outcome !== "object")
              throw new HarnessError(
                "tool.invalid-tool-result",
                "Tool returned an invalid outcome",
              );
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
      state = { ...state, plan };
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
      return finish({ status: "paused" });
    }
    const results = [
      ...plan.immediate,
      ...plan.calls.flatMap((call) => (call.result ? [call.result] : [])),
    ];
    const ordered = plan.order.map((item) =>
      results.find((result) => result.callId === item.callId && result.toolName === item.toolName)!,
    );
    const { plan: _, ...rest } = state;
    state = {
      ...rest,
      transcript: [
        ...state.transcript,
        { kind: "tool-results", turnId: plan.turnId, stepId: plan.stepId, results: ordered },
      ],
    };
    await record();
  }
}

function applyResume(
  state: ExecutionState,
  input: ReturnType<typeof normalizeInput>,
  definitions: Map<string, BoundToolDefinition>,
): ExecutionState {
  const plan = state.plan!;
  let matched = false;
  const calls = plan.calls.map((call) => {
    if (
      input.kind === "settle" &&
      call.status === "deferred" &&
      call.invocationId === input.invocationId
    ) {
      matched = true;
      return {
        ...call,
        status: "settled" as const,
        result: toolResult(call, definitions.get(call.invocationId)!, input.outcome),
      };
    }
    if (
      (input.kind === "approve" || input.kind === "respond") &&
      call.status === "interaction" &&
      call.interaction!.id === input.interactionId
    ) {
      if ((input.kind === "approve") !== (call.interaction!.kind === "approval"))
        throw new HarnessError(
          "execution.invalid-input",
          "Interaction response kind does not match the saved request",
        );
      matched = true;
      const { interaction: _, interactionPhase: __, resume: ___, ...rest } = call;
      if (input.kind === "approve" && !input.approved)
        return {
          ...rest,
          status: "settled" as const,
          result: {
            kind: "denied" as const,
            callId: call.callId,
            toolName: call.toolName,
            reason: "Approval rejected",
          },
        };
      return {
        ...rest,
        status: "pending" as const,
        resume: {
          interactionId: input.interactionId,
          kind: input.kind === "approve" ? ("approval" as const) : ("response" as const),
          ...(input.kind === "approve" ? { approved: input.approved } : { value: input.value }),
          ...(call.token === undefined ? {} : { token: call.token }),
        },
      };
    }
    return call;
  });
  if (!matched)
    throw new HarnessError(
      "execution.invalid-input",
      "Input does not match a pending approval, response, or deferred invocation",
    );
  return copyJson({ ...state, plan: { ...plan, calls } });
}

function toolResult(
  call: SavedToolCall,
  definition: BoundToolDefinition,
  outcome: ToolOutcome,
): ToolResult {
  const identity = { callId: call.callId, toolName: call.toolName };
  if (outcome.kind === "completed") {
    const checked = definition.outputSchema?.validate(outcome.output);
    if (checked && !checked.ok)
      return {
        ...identity,
        kind: "failed",
        code: "tool.invalid-output",
        message: checked.issues.map((issue) => issue.message).join("; "),
        details: { phase: "output", issues: checked.issues },
      };
    return copyJson({
      ...identity,
      kind: "completed",
      output: checked?.ok ? (checked.value as JsonValue) : outcome.output,
    });
  }
  if (
    outcome.kind === "failed" &&
    typeof outcome.code === "string" &&
    typeof outcome.message === "string"
  )
    return copyJson({ ...identity, kind: "failed", code: outcome.code, message: outcome.message });
  if (outcome.kind === "denied" && typeof outcome.reason !== "string")
    throw new HarnessError("tool.invalid-tool-result", "Tool denial reason must be a string");
  if (outcome.kind === "denied" && typeof outcome.reason === "string")
    return copyJson({ ...identity, kind: "denied", reason: outcome.reason });
  throw new HarnessError(
    "tool.invalid-tool-result",
    "Expected a completed, failed, or denied tool result",
  );
}

function lastResults(state: ExecutionState): readonly ToolResult[] {
  const entry = state.transcript[state.transcript.length - 1];
  return entry?.kind === "tool-results" ? entry.results : [];
}

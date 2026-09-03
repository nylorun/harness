import { HarnessError, isHarnessError } from "../errors.js";
import type { ObserveEmit } from "../utils/observe.js";
import type { InputEvent } from "../types/session.js";
import type {
  ActiveInteractionExecutionRecord,
  ActiveToolsExecutionRecord,
} from "../types/session.js";
import type {
  Interaction,
  RequiredInteraction,
  SchemaIssue,
  ToolExecutionResume,
  ToolOutcome,
  ToolResult,
  ToolValidationFailureDetails,
} from "../types/tool.js";
import type { JsonValue, ObserveEvent } from "../types/shared.js";
import { createId } from "../utils/ids.js";
import { assertJson, copyJson, copyJsonObject } from "../utils/immutable.js";
import type { CapabilityStateRegistry } from "../session/capability-state.js";
import type { ExecutablePlanEntry, InternalToolPlan } from "../step/seal.js";

interface PendingBarrier {
  readonly index: number;
  readonly interaction: RequiredInteraction;
  readonly token?: JsonValue;
}

export interface DeferredToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly invocationId: string;
  readonly owner: ExecutablePlanEntry["owner"];
  readonly token?: JsonValue;
}

export type ToolPlanProgress =
  | { readonly kind: "completed"; readonly results: readonly ToolResult[] }
  | { readonly kind: "interaction-required"; readonly interaction: RequiredInteraction }
  | {
      readonly kind: "deferred";
      readonly settled: readonly ToolResult[];
      readonly deferred: readonly DeferredToolCall[];
    };

export interface ToolPlanRunContext {
  readonly signal: AbortSignal;
  readonly observe: ObserveEmit;
  readonly ids: { readonly sessionId: string; readonly turnId: string; readonly stepId: string };
  readonly states?: CapabilityStateRegistry;
}

/** Owns one sealed plan's deterministic interaction and concurrent execution progress. */
export class ToolPlanRunner {
  private readonly results: Map<string, ToolResult>;
  private readonly deferred = new Map<string, DeferredToolCall>();
  private readonly resumes = new Map<string, ToolExecutionResume>();
  private readonly pending: PendingBarrier[] = [];
  private readonly settlementEvents: ObserveEvent[] = [];
  private interactionIndex = 0;
  private executeStarted = false;
  private resumeExecute?: ExecutablePlanEntry;

  constructor(private readonly plan: InternalToolPlan) {
    this.results = new Map(plan.immediateResults.map((item) => [item.callId, item]));
  }

  get interactionId(): string | undefined {
    return this.pending[0]?.interaction.id;
  }
  get interactionKind(): RequiredInteraction["kind"] | undefined {
    return this.pending[0]?.interaction.kind;
  }
  get interactionCallId(): string | undefined {
    const pending = this.pending[0];
    return pending ? this.plan.executable[pending.index]?.call.callId : undefined;
  }
  get interactionToolName(): string | undefined {
    const pending = this.pending[0];
    return pending ? this.plan.executable[pending.index]?.call.toolName : undefined;
  }

  cancelledResults(reason: string): readonly ToolResult[] {
    return this.resultsInOrder("tool.cancelled", reason);
  }

  /** Publishes settlement facts only after their authoritative state was recorded. */
  publishSettlements(observe: ObserveEmit): void {
    for (const event of this.settlementEvents.splice(0)) observe(event);
  }

  activeToolsRecord(turnId: string, stepId: string): ActiveToolsExecutionRecord {
    return Object.freeze({
      kind: "tools",
      turnId,
      stepId,
      calls: Object.freeze(
        this.plan.executable.map((entry) => {
          const result = this.results.get(entry.call.callId);
          const deferred = this.deferred.get(entry.call.callId);
          return Object.freeze({
            callId: entry.call.callId,
            toolName: entry.call.toolName,
            args: copyJson(entry.call.args),
            invocationId: entry.invocationId,
            owner: entry.owner,
            status: result
              ? ("settled" as const)
              : deferred
                ? ("deferred" as const)
                : ("pending" as const),
            ...(result ? { result } : {}),
            ...(deferred?.token === undefined ? {} : { token: deferred.token }),
          });
        }),
      ),
    });
  }

  activeInteractionRecord(
    turnId: string,
    stepId: string,
    resume?: ToolExecutionResume,
  ): ActiveInteractionExecutionRecord {
    const pending = this.pending[0];
    const entry = pending ? this.plan.executable[pending.index] : undefined;
    if (!pending || !entry)
      throw new HarnessError("interaction.invalid", "Missing pending interaction state");
    return Object.freeze({
      kind: "interaction",
      turnId,
      stepId,
      callId: entry.call.callId,
      toolName: entry.call.toolName,
      interaction: pending.interaction,
      ...(pending.token === undefined ? {} : { token: pending.token }),
      ...(resume === undefined ? {} : { resume }),
      tools: this.activeToolsRecord(turnId, stepId),
    });
  }

  interactionResume(event: InputEvent): ToolExecutionResume {
    const pending = this.pending[0];
    if (!pending)
      throw new HarnessError("interaction.invalid", "Missing pending interaction state");
    return resumeValue(event, pending);
  }

  async run(context: ToolPlanRunContext, resume?: InputEvent): Promise<ToolPlanProgress> {
    this.acceptResume(resume);
    while (this.interactionIndex < this.plan.executable.length) {
      this.throwIfAborted(context.signal);
      const entry = this.plan.executable[this.interactionIndex]!;
      if (this.results.has(entry.call.callId)) {
        this.interactionIndex += 1;
        continue;
      }
      if (entry.interaction) {
        this.enqueueInteraction({ index: this.interactionIndex, interaction: entry.interaction });
        return this.interactionRequired();
      }
      this.interactionIndex += 1;
    }

    if (this.resumeExecute) {
      const entry = this.resumeExecute;
      this.resumeExecute = undefined;
      await this.executeBatch([entry], context);
    } else if (!this.executeStarted) {
      this.executeStarted = true;
      await this.executeBatch(
        this.plan.executable.filter((entry) => !this.results.has(entry.call.callId)),
        context,
      );
    }

    if (this.pending.length) return this.interactionRequired();
    if (this.deferred.size)
      return {
        kind: "deferred",
        settled: this.orderedSettledResults(),
        deferred: Object.freeze(
          this.plan.executable.flatMap((entry) => {
            const value = this.deferred.get(entry.call.callId);
            return value ? [value] : [];
          }),
        ),
      };
    return { kind: "completed", results: this.orderedResults() };
  }

  private acceptResume(resume?: InputEvent): void {
    const pending = this.pending.shift();
    if (!pending) return;
    if (!resume)
      throw new HarnessError(
        "interaction.missing-resume",
        "A pending tool plan requires a correlated interaction input",
      );
    const value = resumeValue(resume, pending);
    const entry = this.plan.executable[pending.index]!;
    if (value.kind === "approval" && value.approved === false) {
      this.results.set(
        entry.call.callId,
        Object.freeze({
          callId: entry.call.callId,
          toolName: entry.call.toolName,
          kind: "denied",
          reason: "Approval rejected",
        }),
      );
      this.interactionIndex = Math.max(this.interactionIndex, pending.index + 1);
      return;
    }
    this.resumes.set(entry.call.callId, value);
    if (this.executeStarted) this.resumeExecute = entry;
    else this.interactionIndex = Math.max(this.interactionIndex, pending.index + 1);
  }

  private async executeBatch(
    entries: readonly ExecutablePlanEntry[],
    context: ToolPlanRunContext,
  ): Promise<void> {
    const settled = await Promise.allSettled(entries.map((entry) => this.execute(entry, context)));
    if (context.signal.aborted) throw context.signal.reason;
    for (const outcome of settled) {
      if (outcome.status === "rejected") throw outcome.reason;
      if (outcome.value) this.enqueueInteraction(outcome.value);
    }
  }

  private async execute(
    entry: ExecutablePlanEntry,
    context: ToolPlanRunContext,
  ): Promise<PendingBarrier | undefined> {
    context.observe({
      type: "tool.started",
      sessionId: context.ids.sessionId,
      turnId: context.ids.turnId,
      stepId: context.ids.stepId,
      toolName: entry.call.toolName,
      callId: entry.call.callId,
      invocationId: entry.invocationId,
      middlewareId: entry.owner.middlewareId,
      slot: entry.owner.slot,
      attributes: { args: copyJson(entry.call.args) },
    });
    try {
      const toolContext: Record<string, unknown> = {
        sessionId: context.ids.sessionId,
        turnId: context.ids.turnId,
        stepId: context.ids.stepId,
        callId: entry.call.callId,
        invocationId: entry.invocationId,
        signal: context.signal,
        resume: this.takeResume(entry.call.callId),
      };
      if (context.states?.has(entry.owner.middlewareId))
        Object.defineProperty(toolContext, "state", {
          enumerable: true,
          get: () => context.states!.get(entry.owner.middlewareId),
        });
      const outcome = await entry.execute(
        entry.call.args as never,
        Object.freeze(toolContext) as import("../types/tool.js").ToolExecutionContext,
      );
      this.throwIfAborted(context.signal);
      if (!outcome || typeof outcome !== "object" || typeof outcome.kind !== "string")
        throw new HarnessError("tool.invalid-tool-result", "Tool returned an invalid outcome");
      if (outcome.kind === "interaction-required")
        return interactionBarrier(this.plan.executable.indexOf(entry), outcome);
      if (outcome.kind === "deferred") {
        const value = Object.freeze({
          callId: entry.call.callId,
          toolName: entry.call.toolName,
          args: copyJson(entry.call.args),
          invocationId: entry.invocationId,
          owner: entry.owner,
          ...(outcome.token === undefined ? {} : { token: copyJson(outcome.token) }),
        });
        this.deferred.set(entry.call.callId, value);
        this.settlementEvents.push({
          type: "tool.deferred",
          sessionId: context.ids.sessionId,
          turnId: context.ids.turnId,
          stepId: context.ids.stepId,
          toolName: entry.call.toolName,
          callId: entry.call.callId,
          invocationId: entry.invocationId,
          middlewareId: entry.owner.middlewareId,
          slot: entry.owner.slot,
          attributes: outcome.token === undefined ? {} : { token: copyJson(outcome.token) },
        });
        return undefined;
      }
      const result = resultFrom(entry, outcome);
      this.results.set(entry.call.callId, result);
      this.settlementEvents.push(completedEvent(entry, context, result));
    } catch (error) {
      this.throwIfAborted(context.signal);
      const result = failed(
        entry,
        isHarnessError(error) ? error.code : "tool.execution-failed",
        error,
      );
      this.results.set(entry.call.callId, result);
      this.settlementEvents.push(completedEvent(entry, context, result));
    }
    return undefined;
  }

  private takeResume(callId: string): ToolExecutionResume | undefined {
    const value = this.resumes.get(callId);
    this.resumes.delete(callId);
    return value;
  }

  private enqueueInteraction(pending: PendingBarrier): void {
    const position = this.pending.findIndex((item) => item.index > pending.index);
    if (position === -1) this.pending.push(pending);
    else this.pending.splice(position, 0, pending);
  }

  private interactionRequired(): ToolPlanProgress {
    const pending = this.pending[0];
    if (!pending) throw new HarnessError("interaction.invalid", "Missing pending interaction");
    return { kind: "interaction-required", interaction: pending.interaction };
  }

  private orderedResults(): readonly ToolResult[] {
    return this.resultsInOrder("tool.missing-result", "Tool call did not produce a result");
  }

  private orderedSettledResults(): readonly ToolResult[] {
    return Object.freeze(
      this.plan.order.flatMap(({ callId }) => {
        const result = this.results.get(callId);
        return result ? [result] : [];
      }),
    );
  }

  private resultsInOrder(code: string, message: string): readonly ToolResult[] {
    return Object.freeze(
      this.plan.order.map(
        ({ callId, toolName }) =>
          this.results.get(callId) ??
          Object.freeze({ kind: "failed" as const, callId, toolName, code, message }),
      ),
    );
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
  }
}

function interactionBarrier(
  index: number,
  outcome: Extract<ToolOutcome, { kind: "interaction-required" }>,
): PendingBarrier {
  return {
    index,
    interaction: normalizeInteraction(outcome.interaction),
    ...(outcome.token === undefined ? {} : { token: copyJson(outcome.token) }),
  };
}

function normalizeInteraction(value: Interaction): RequiredInteraction {
  if (!value || typeof value !== "object")
    throw new HarnessError("interaction.invalid", "Interaction must be an object");
  if (value.kind !== "approval" && value.kind !== "response")
    throw new HarnessError("interaction.invalid", "Interaction kind must be approval or response");
  if (typeof value.prompt !== "string")
    throw new HarnessError("interaction.invalid", "Interaction prompt must be a string");
  if (value.id !== undefined && (typeof value.id !== "string" || !value.id))
    throw new HarnessError("interaction.invalid", "Interaction id must be a non-empty string");
  return Object.freeze({
    id: value.id ?? createId("interaction"),
    kind: value.kind,
    prompt: value.prompt,
    ...(value.metadata === undefined
      ? {}
      : { metadata: copyJsonObject(value.metadata, "interaction metadata") }),
  });
}

function resumeValue(event: InputEvent, pending: PendingBarrier): ToolExecutionResume {
  if (event.kind === "approve")
    return Object.freeze({
      interactionId: event.interactionId,
      kind: "approval",
      approved: event.approved,
      ...(pending.token === undefined ? {} : { token: pending.token }),
    });
  if (event.kind === "respond")
    return Object.freeze({
      interactionId: event.interactionId,
      kind: "response",
      value: event.value,
      ...(pending.token === undefined ? {} : { token: pending.token }),
    });
  throw new HarnessError(
    "interaction.uncorrelated-resume",
    "Only correlated interaction input can resume a plan",
  );
}

function resultFrom(
  entry: ExecutablePlanEntry,
  outcome: Extract<ToolOutcome, { kind: "completed" | "denied" | "failed" }>,
): ToolResult {
  const base = { callId: entry.call.callId, toolName: entry.call.toolName };
  switch (outcome.kind) {
    case "completed": {
      const output = validatedOutput(entry, outcome.output);
      if (!output.ok)
        return Object.freeze({
          ...base,
          kind: "failed",
          code: "tool.invalid-output",
          message: output.message,
          details: output.details,
        });
      return Object.freeze({ ...base, kind: "completed", output: output.value });
    }
    case "denied":
      if (typeof outcome.reason !== "string")
        throw new HarnessError("tool.invalid-tool-result", "Tool denial reason must be a string");
      return Object.freeze({ ...base, kind: "denied", reason: outcome.reason });
    case "failed":
      if (typeof outcome.code !== "string" || typeof outcome.message !== "string")
        throw new HarnessError(
          "tool.invalid-tool-result",
          "Tool failure code and message must be strings",
        );
      return Object.freeze({
        ...base,
        kind: "failed",
        code: outcome.code,
        message: outcome.message,
      });
  }
}

function validatedOutput(
  entry: ExecutablePlanEntry,
  value: unknown,
):
  | { readonly ok: true; readonly value: import("../types/shared.js").JsonValue }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details: ToolValidationFailureDetails;
    } {
  const validation = entry.outputSchema?.validate(value) ?? { ok: true as const, value };
  if (!validation.ok) return validationFailure("output", validation.issues);
  try {
    assertJson(validation.value, `output for '${entry.call.toolName}'`);
    return { ok: true, value: copyJson(validation.value) };
  } catch (error) {
    return validationFailure("output", [
      Object.freeze({
        path: Object.freeze([]),
        code: "invalid_json",
        message: error instanceof Error ? error.message : String(error),
      }),
    ]);
  }
}

function validationFailure(
  phase: "input" | "output",
  issues: readonly SchemaIssue[],
): {
  readonly ok: false;
  readonly message: string;
  readonly details: ToolValidationFailureDetails;
} {
  return {
    ok: false,
    message: issues.map((item) => `${item.path.join(".") || "(root)"}: ${item.message}`).join("; "),
    details: Object.freeze({ phase, issues: Object.freeze([...issues]) }),
  };
}

function completedEvent(
  entry: ExecutablePlanEntry,
  context: ToolPlanRunContext,
  result: ToolResult,
): ObserveEvent {
  return {
    type: "tool.completed",
    sessionId: context.ids.sessionId,
    turnId: context.ids.turnId,
    stepId: context.ids.stepId,
    toolName: entry.call.toolName,
    callId: entry.call.callId,
    invocationId: entry.invocationId,
    middlewareId: entry.owner.middlewareId,
    slot: entry.owner.slot,
    outcome: result.kind,
    ...(result.kind === "failed" ? { code: result.code } : {}),
    attributes: copyJson(result),
  };
}

function failed(entry: ExecutablePlanEntry, code: string, error: unknown): ToolResult {
  return Object.freeze({
    callId: entry.call.callId,
    toolName: entry.call.toolName,
    kind: "failed",
    code,
    message: error instanceof Error ? error.message : String(error),
  });
}

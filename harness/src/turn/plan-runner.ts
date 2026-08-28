import type { AdapterRegistry } from "../build/adapters.js";
import { HarnessError, isHarnessError } from "../errors.js";
import type { ObserveEmit } from "../utils/observe.js";
import type { InputEvent } from "../types/session.js";
import type {
  Interaction,
  RequiredInteraction,
  ToolExecutionResume,
  ToolOutcome,
  ToolResult,
} from "../types/tool.js";
import { createId } from "../utils/ids.js";
import { copyJson, copyJsonObject } from "../utils/immutable.js";
import type { ExecutablePlanEntry, InternalToolPlan } from "../step/seal.js";

type PlanPhase = "interaction" | "preflight" | "execute";

interface PendingBarrier {
  readonly phase: PlanPhase;
  readonly index: number;
  readonly interaction: RequiredInteraction;
  readonly token?: import("../types/shared.js").JsonValue;
}

export type ToolPlanProgress =
  | { readonly kind: "completed"; readonly results: readonly ToolResult[] }
  | { readonly kind: "interaction-required"; readonly interaction: RequiredInteraction };

export interface ToolPlanRunContext {
  readonly adapters: AdapterRegistry;
  readonly signal: AbortSignal;
  readonly observe: ObserveEmit;
  readonly ids: { readonly sessionId: string; readonly turnId: string; readonly stepId: string };
}

/** Owns the mutable progress of one sealed tool plan across interaction resumes. */
export class ToolPlanRunner {
  private readonly results: Map<string, ToolResult>;
  private readonly resumes = new Map<string, ToolExecutionResume>();
  private phase: PlanPhase = "interaction";
  private index = 0;
  private readonly pending: PendingBarrier[] = [];
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
    if (!pending) return undefined;
    return this.plan.executable[pending.index]?.call.callId;
  }
  get interactionToolName(): string | undefined {
    const pending = this.pending[0];
    if (!pending) return undefined;
    return this.plan.executable[pending.index]?.call.toolName;
  }
  get interactionPhase(): PlanPhase | undefined {
    return this.pending[0]?.phase;
  }

  cancelledResults(reason: string): readonly ToolResult[] {
    return this.resultsInOrder("tool.cancelled", reason);
  }

  async run(context: ToolPlanRunContext, resume?: InputEvent): Promise<ToolPlanProgress> {
    this.acceptResume(resume);
    while (true) {
      this.throwIfAborted(context.signal);
      if (this.phase === "execute") return this.runExecute(context);
      if (this.index >= this.plan.executable.length) {
        if (this.phase === "interaction") {
          this.phase = "preflight";
          this.index = 0;
          continue;
        }
        if (this.phase === "preflight") {
          this.phase = "execute";
          this.index = 0;
          continue;
        }
        return { kind: "completed", results: this.orderedResults() };
      }

      const entry = this.plan.executable[this.index]!;
      if (this.results.has(entry.call.callId)) {
        this.index += 1;
        continue;
      }

      if (this.phase === "interaction") {
        if (!entry.interaction) {
          this.index += 1;
          continue;
        }
        return this.requireInteraction({
          phase: this.phase,
          index: this.index,
          interaction: entry.interaction,
        });
      }

      const adapter = context.adapters.require(entry.call.executeWith);
      if (this.phase === "preflight") {
        const progress = await this.preflight(entry, adapter, context);
        if (progress) return progress;
      }
      this.index += 1;
    }
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
      this.index += 1;
      return;
    }
    if (pending.phase === "interaction") {
      this.resumes.set(entry.call.callId, value);
      this.index += 1;
      return;
    }
    this.resumes.set(`${pending.phase}:${entry.call.callId}`, value);
    if (pending.phase === "execute") this.resumeExecute = entry;
  }

  private async runExecute(context: ToolPlanRunContext): Promise<ToolPlanProgress> {
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
    return this.pending.length
      ? this.interactionRequired()
      : { kind: "completed", results: this.orderedResults() };
  }

  private async preflight(
    entry: ExecutablePlanEntry,
    adapter: ReturnType<AdapterRegistry["require"]>,
    context: ToolPlanRunContext,
  ): Promise<ToolPlanProgress | undefined> {
    if (!entry.preflight) return undefined;
    if (!adapter.preflight) {
      this.results.set(
        entry.call.callId,
        failed(
          entry,
          "tool.preflight-missing",
          `Adapter '${entry.call.executeWith}' does not implement preflight`,
        ),
      );
      return undefined;
    }
    context.observe({
      type: "adapter.preflight.started",
      turnId: context.ids.turnId,
      stepId: context.ids.stepId,
      adapterId: adapter.id,
      toolName: entry.call.toolName,
      callId: entry.call.callId,
      invocationId: entry.invocationId,
      attributes: { args: copyJson(entry.call.args) },
    });
    try {
      const outcome = await adapter.preflight(entry.call, {
        kind: entry.preflight,
        invocationId: entry.invocationId,
        signal: context.signal,
        resume: this.takeResume("preflight", entry.call.callId),
      });
      this.throwIfAborted(context.signal);
      if (outcome.kind === "interaction-required")
        return this.requireInteraction(interactionBarrier(this.phase, this.index, outcome));
      if (outcome.kind !== "completed")
        this.results.set(entry.call.callId, resultFrom(entry, outcome));
      context.observe({
        type: "adapter.preflight.completed",
        turnId: context.ids.turnId,
        stepId: context.ids.stepId,
        adapterId: adapter.id,
        toolName: entry.call.toolName,
        callId: entry.call.callId,
        outcome: outcome.kind,
        ...adapterCompleted(this.results.get(entry.call.callId)),
      });
    } catch (error) {
      this.throwIfAborted(context.signal);
      const result = failed(
        entry,
        isHarnessError(error) ? error.code : "tool.preflight-failed",
        error,
      );
      this.results.set(entry.call.callId, result);
      context.observe({
        type: "adapter.preflight.completed",
        turnId: context.ids.turnId,
        stepId: context.ids.stepId,
        adapterId: adapter.id,
        toolName: entry.call.toolName,
        callId: entry.call.callId,
        outcome: "failed",
        ...adapterCompleted(result),
      });
    }
    return undefined;
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
    const adapter = context.adapters.require(entry.call.executeWith);
    try {
      return await context.adapters.execute(adapter.id, context.signal, async () => {
        context.observe({
          type: "adapter.started",
          turnId: context.ids.turnId,
          stepId: context.ids.stepId,
          adapterId: adapter.id,
          toolName: entry.call.toolName,
          callId: entry.call.callId,
          invocationId: entry.invocationId,
          attributes: { args: copyJson(entry.call.args) },
        });
        const outcome = await adapter.execute(entry.call, {
          invocationId: entry.invocationId,
          signal: context.signal,
          resume: this.takeResume("execute", entry.call.callId),
        });
        this.throwIfAborted(context.signal);
        if (outcome.kind === "interaction-required")
          return interactionBarrier("execute", this.plan.executable.indexOf(entry), outcome);
        this.results.set(entry.call.callId, resultFrom(entry, outcome));
        context.observe({
          type: "adapter.completed",
          turnId: context.ids.turnId,
          stepId: context.ids.stepId,
          adapterId: adapter.id,
          toolName: entry.call.toolName,
          callId: entry.call.callId,
          outcome: outcome.kind,
          ...adapterCompleted(this.results.get(entry.call.callId)),
        });
        return undefined;
      });
    } catch (error) {
      this.throwIfAborted(context.signal);
      const result = failed(
        entry,
        isHarnessError(error) ? error.code : "tool.execution-failed",
        error,
      );
      this.results.set(entry.call.callId, result);
      context.observe({
        type: "adapter.completed",
        turnId: context.ids.turnId,
        stepId: context.ids.stepId,
        adapterId: adapter.id,
        toolName: entry.call.toolName,
        callId: entry.call.callId,
        outcome: "failed",
        ...adapterCompleted(result),
      });
    }
    return undefined;
  }

  private takeResume(
    phase: Extract<PlanPhase, "preflight" | "execute">,
    callId: string,
  ): ToolExecutionResume | undefined {
    const phased = `${phase}:${callId}`;
    const resume = this.resumes.get(phased) ?? this.resumes.get(callId);
    this.resumes.delete(phased);
    return resume;
  }

  private requireInteraction(pending: PendingBarrier): ToolPlanProgress {
    this.enqueueInteraction(pending);
    return this.interactionRequired();
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

  private resultsInOrder(code: string, message: string): readonly ToolResult[] {
    return Object.freeze(
      this.plan.order.map(
        ({ callId, toolName }) =>
          this.results.get(callId) ??
          Object.freeze({
            callId,
            toolName,
            kind: "failed" as const,
            code,
            message,
          }),
      ),
    );
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
  }
}

function interactionBarrier(
  phase: PlanPhase,
  index: number,
  outcome: Extract<ToolOutcome, { kind: "interaction-required" }>,
): PendingBarrier {
  return {
    phase,
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
  outcome: Exclude<ToolOutcome, { kind: "interaction-required" }>,
): ToolResult {
  const base = { callId: entry.call.callId, toolName: entry.call.toolName };
  switch (outcome.kind) {
    case "completed":
      return Object.freeze({ ...base, kind: "completed", output: copyJson(outcome.output) });
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
    default:
      throw new HarnessError("adapter.invalid-outcome", "Tool adapter returned an invalid outcome");
  }
}

function adapterCompleted(result?: ToolResult): {
  readonly code?: string;
  readonly attributes?: ToolResult;
} {
  if (!result) return {};
  return {
    ...(result.code === undefined ? {} : { code: result.code }),
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

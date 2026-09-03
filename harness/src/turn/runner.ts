import type {
  ActiveExecutionRecord,
  InputEvent,
  SessionEvent,
  SessionRecord,
  SessionSnapshot,
} from "../types/session.js";
import type { JsonObject, JsonValue, Tripwire } from "../types/shared.js";
import type { RequiredInteraction, ToolResult } from "../types/tool.js";
import {
  beginTurn,
  commitCandidate,
  commitFinal,
  commitToolResults,
  withStatus,
} from "../session/state.js";
import type { LoopAgent } from "../build/agent.js";
import { runStep } from "../step/run.js";
import { createId } from "../utils/ids.js";
import { copyJson } from "../utils/immutable.js";
import type { ObserveEmit } from "../utils/observe.js";
import { ToolPlanRunner } from "./plan-runner.js";
import type { CapabilityStateRegistry } from "../session/capability-state.js";
import type { TurnOutputContract } from "../session/output-contract.js";

export interface PendingTurn {
  readonly plan: ToolPlanRunner;
  readonly turnId: string;
  readonly stepId: string;
  readonly stepNumber: number;
  readonly output?: TurnOutputContract;
}

export type TurnProgress =
  | {
      readonly kind: "final";
      readonly state: SessionSnapshot;
      readonly turnId: string;
      readonly stepId: string;
      readonly output: JsonValue;
    }
  | {
      readonly kind: "interaction-required";
      readonly state: SessionSnapshot;
      readonly pending: PendingTurn;
      readonly interaction: RequiredInteraction;
    }
  | {
      readonly kind: "deferred";
      readonly state: SessionSnapshot;
      readonly turnId: string;
      readonly stepId: string;
      readonly active: ActiveExecutionRecord;
    }
  | {
      readonly kind: "tripwire";
      readonly state: SessionSnapshot;
      readonly turnId: string;
      readonly stepId?: string;
      readonly tripwire: Tripwire;
    };

export interface TurnRunContext {
  readonly signal: AbortSignal;
  readonly states: CapabilityStateRegistry;
  readonly observe: ObserveEmit;
  readonly assertCurrent: () => void;
  readonly onPlanActive: (pending: PendingTurn | undefined) => void;
  readonly commit: (
    state: SessionSnapshot,
    transition: SessionRecord["transition"],
    active?: ActiveExecutionRecord,
  ) => Promise<SessionSnapshot>;
  readonly onConversation: (event: SessionEvent<JsonValue>) => void;
  readonly claimInterrupts: (
    state: SessionSnapshot,
    turnId: string,
  ) => Promise<{ readonly state: SessionSnapshot; readonly arrivals: readonly InputEvent[] }>;
}

/** Advances one Turn until it finalizes, trips policy, or reaches a waiting barrier. */
export class TurnRunner {
  constructor(
    private readonly agent: LoopAgent,
    private readonly sessionId: string,
    private readonly session: Readonly<{ readonly userId?: string; readonly context?: JsonObject }>,
  ) {}

  async start(
    state: SessionSnapshot,
    event: InputEvent,
    context: TurnRunContext,
    output?: TurnOutputContract,
  ): Promise<TurnProgress> {
    const turnId = createId("turn");
    state = await context.commit(beginTurn(state, turnId, event), "input");
    context.onConversation({ type: "input", event, turnId });
    return this.advance(state, turnId, 1, [event], [], context, output);
  }

  async continue(state: SessionSnapshot, context: TurnRunContext): Promise<TurnProgress> {
    const turnId = createId("turn");
    return this.advance(beginTurn(state, turnId), turnId, 1, [], [], context);
  }

  async resume(
    state: SessionSnapshot,
    pending: PendingTurn,
    event: InputEvent,
    context: TurnRunContext,
  ): Promise<TurnProgress> {
    const resume = pending.plan.interactionResume(event);
    const active = pending.plan.activeInteractionRecord(pending.turnId, pending.stepId, resume);
    state = await context.commit(withStatus(state, "running", undefined, active), "input", active);
    context.onConversation({ type: "input", event, turnId: pending.turnId });
    const progress = await this.runPlan(pending, context, event);
    if (progress.kind === "interaction-required")
      return this.waitForInteraction(state, pending, progress.interaction, context);
    if (progress.kind === "deferred")
      return this.waitForDeferred(
        state,
        pending,
        pending.plan.activeToolsRecord(pending.turnId, pending.stepId),
        context,
      );
    state = await context.commit(
      commitToolResults(state, pending.turnId, pending.stepId, progress.results),
      "tool-results",
    );
    pending.plan.publishSettlements(context.observe);
    const claimed = await context.claimInterrupts(state, pending.turnId);
    return this.advance(
      claimed.state,
      pending.turnId,
      pending.stepNumber + 1,
      claimed.arrivals,
      progress.results,
      context,
      pending.output,
    );
  }

  private async advance(
    initialState: SessionSnapshot,
    turnId: string,
    firstStep: number,
    arrivals: readonly InputEvent[],
    initialResults: readonly ToolResult[],
    context: TurnRunContext,
    output?: TurnOutputContract,
  ): Promise<TurnProgress> {
    let state = initialState;
    let stepArrivals = arrivals;
    let toolResults = initialResults;
    for (let stepNumber = firstStep; ; stepNumber += 1) {
      const stepId = createId("step");
      const run = await runStep({
        agent: this.agent,
        observe: context.observe,
        state,
        sessionId: this.sessionId,
        turnId,
        stepId,
        turnNumber: state.turnCount,
        stepNumber,
        arrivals: stepArrivals,
        toolResults,
        signal: context.signal,
        session: this.session,
        states: context.states,
        output,
        recordModelRequested: (next, active) => context.commit(next, "model-requested", active),
      });
      context.assertCurrent();
      state = run.state;

      const pending =
        run.output.kind === "tools"
          ? {
              plan: new ToolPlanRunner(run.output.plan),
              turnId,
              stepId,
              stepNumber,
              ...(output === undefined ? {} : { output }),
            }
          : undefined;

      if (run.candidate) {
        const active = pending?.plan.activeToolsRecord(turnId, stepId);
        state = await context.commit(
          commitCandidate(state, turnId, stepId, run.candidate),
          "candidate",
          active,
        );
        context.observe({
          type: "model.completed",
          turnId,
          stepId,
          ...(run.requestedModelId === undefined ? {} : { requestedModelId: run.requestedModelId }),
          attributes: run.candidate,
        });
        context.onConversation({ type: "candidate", turnId, stepId, candidate: run.candidate });
      }

      if (run.output.kind === "tripwire")
        return { kind: "tripwire", state, turnId, stepId, tripwire: run.output.tripwire };
      if (run.output.kind === "deferred-model") {
        state = await context.commit(
          withStatus(state, "waiting", undefined, run.output.active),
          "waiting",
          run.output.active,
        );
        return { kind: "deferred", state, turnId, stepId, active: run.output.active };
      }
      if (run.output.kind === "final") {
        state = await context.commit(
          withStatus(commitFinal(state, turnId, stepId, run.output.output), "idle"),
          "final",
        );
        return { kind: "final", state, turnId, stepId, output: run.output.output };
      }

      const toolPlan = run.output.plan;

      context.observe(() => ({
        type: "tool.sealed",
        turnId,
        stepId,
        attributes: {
          executable: Object.freeze(
            toolPlan.executable.map((entry) =>
              Object.freeze({
                callId: entry.call.callId,
                toolName: entry.call.toolName,
                args: copyJson(entry.call.args),
                invocationId: entry.invocationId,
                owner: entry.owner,
                ...(entry.interaction === undefined
                  ? {}
                  : { interaction: copyJson(entry.interaction) }),
              }),
            ),
          ),
          immediate: copyJson(toolPlan.immediateResults),
        },
      }));
      const progress = await this.runPlan(pending!, context);
      if (progress.kind === "interaction-required")
        return this.waitForInteraction(state, pending!, progress.interaction, context);
      if (progress.kind === "deferred")
        return this.waitForDeferred(
          state,
          pending!,
          pending!.plan.activeToolsRecord(turnId, stepId),
          context,
        );
      state = await context.commit(
        commitToolResults(state, turnId, stepId, progress.results),
        "tool-results",
      );
      pending!.plan.publishSettlements(context.observe);
      const claimed = await context.claimInterrupts(state, turnId);
      state = claimed.state;
      stepArrivals = claimed.arrivals;
      toolResults = progress.results;
    }
  }

  private async waitForInteraction(
    state: SessionSnapshot,
    pending: PendingTurn,
    interaction: RequiredInteraction,
    context: TurnRunContext,
  ): Promise<TurnProgress> {
    const active = pending.plan.activeInteractionRecord(pending.turnId, pending.stepId);
    state = await context.commit(
      withStatus(state, "waiting", interaction, active),
      "waiting",
      active,
    );
    pending.plan.publishSettlements(context.observe);
    return { kind: "interaction-required", state, pending, interaction };
  }

  private async waitForDeferred(
    state: SessionSnapshot,
    pending: PendingTurn,
    active: ActiveExecutionRecord,
    context: TurnRunContext,
  ): Promise<TurnProgress> {
    state = await context.commit(
      withStatus(state, "waiting", undefined, active),
      "waiting",
      active,
    );
    pending.plan.publishSettlements(context.observe);
    return {
      kind: "deferred",
      state,
      turnId: pending.turnId,
      stepId: pending.stepId,
      active,
    };
  }

  private async runPlan(pending: PendingTurn, context: TurnRunContext, resume?: InputEvent) {
    context.onPlanActive(pending);
    const progress = await pending.plan.run(
      {
        signal: context.signal,
        observe: context.observe,
        ids: { sessionId: this.sessionId, turnId: pending.turnId, stepId: pending.stepId },
        states: context.states,
      },
      resume,
    );
    context.assertCurrent();
    context.onPlanActive(undefined);
    return progress;
  }
}

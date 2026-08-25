import type { InputEvent, SessionSnapshot } from "../types/session.js";
import type { JsonObject, Tripwire } from "../types/shared.js";
import type { RequiredInteraction, ToolResult } from "../types/tool.js";
import { beginTurn, commitCandidate, commitFinal, commitToolResults } from "../session/state.js";
import { runStep, type LoopAgent } from "../step/run.js";
import { createId } from "../utils/ids.js";
import { ToolPlanRunner } from "./plan-runner.js";

export interface PendingTurn {
  readonly plan: ToolPlanRunner;
  readonly turnId: string;
  readonly stepId: string;
  readonly stepNumber: number;
}

export type TurnProgress =
  | {
      readonly kind: "final";
      readonly state: SessionSnapshot;
      readonly turnId: string;
      readonly stepId: string;
      readonly output: string;
    }
  | {
      readonly kind: "interaction-required";
      readonly state: SessionSnapshot;
      readonly pending: PendingTurn;
      readonly interaction: RequiredInteraction;
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
  readonly observe: (event: import("../types/shared.js").ObserveEvent) => void;
  readonly assertCurrent: () => void;
  readonly onPlanActive: (pending: PendingTurn | undefined) => void;
  readonly onState: (state: SessionSnapshot) => void;
}

/** Advances one Turn until it finalizes, trips a policy, or pauses for an interaction. */
export class TurnRunner {
  constructor(
    private readonly agent: LoopAgent,
    private readonly defaultModel: string,
    private readonly sessionId: string,
    private readonly session: Readonly<{ readonly userId?: string; readonly context?: JsonObject }>,
  ) {}

  async start(
    state: SessionSnapshot,
    event: InputEvent,
    context: TurnRunContext,
  ): Promise<TurnProgress> {
    const turnId = createId("turn");
    const started = beginTurn(state, turnId, event);
    context.onState(started);
    return this.advance(started, turnId, 1, [event], [], context);
  }

  async resume(
    state: SessionSnapshot,
    pending: PendingTurn,
    event: InputEvent,
    context: TurnRunContext,
  ): Promise<TurnProgress> {
    const progress = await this.runPlan(pending, context, event);
    if (progress.kind === "interaction-required")
      return { kind: "interaction-required", state, pending, interaction: progress.interaction };
    const afterTools = commitToolResults(state, pending.turnId, pending.stepId, progress.results);
    context.onState(afterTools);
    return this.advance(
      afterTools,
      pending.turnId,
      pending.stepNumber + 1,
      [],
      progress.results,
      context,
    );
  }

  private async advance(
    initialState: SessionSnapshot,
    turnId: string,
    firstStep: number,
    arrivals: readonly InputEvent[],
    initialResults: readonly ToolResult[],
    context: TurnRunContext,
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
        defaultModel: this.defaultModel,
        signal: context.signal,
        session: this.session,
      });
      context.assertCurrent();
      if (run.candidate) {
        state = commitCandidate(state, turnId, stepId, run.candidate);
        context.onState(state);
      }

      if (run.output.kind === "tripwire")
        return { kind: "tripwire", state, turnId, stepId, tripwire: run.output.tripwire };
      if (run.output.kind === "final")
        return {
          kind: "final",
          state: commitFinal(state, turnId, stepId, run.output.output),
          turnId,
          stepId,
          output: run.output.output,
        };

      context.observe({
        type: "tool.sealed",
        turnId,
        stepId,
        attributes: { calls: run.output.plan.executable.length },
      });
      const pending: PendingTurn = {
        plan: new ToolPlanRunner(run.output.plan),
        turnId,
        stepId,
        stepNumber,
      };
      const progress = await this.runPlan(pending, context);
      if (progress.kind === "interaction-required")
        return { kind: "interaction-required", state, pending, interaction: progress.interaction };
      state = commitToolResults(state, turnId, stepId, progress.results);
      context.onState(state);
      stepArrivals = [];
      toolResults = progress.results;
    }
  }

  private async runPlan(pending: PendingTurn, context: TurnRunContext, resume?: InputEvent) {
    context.onPlanActive(pending);
    const progress = await pending.plan.run(
      {
        adapters: this.agent.adapters,
        signal: context.signal,
        observe: context.observe,
        ids: { sessionId: this.sessionId, turnId: pending.turnId, stepId: pending.stepId },
      },
      resume,
    );
    context.assertCurrent();
    context.onPlanActive(undefined);
    return progress;
  }
}

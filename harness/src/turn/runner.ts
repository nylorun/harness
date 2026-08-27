import type { InputEvent, SessionEvent, SessionSnapshot } from "../types/session.js";
import type { JsonObject, Tripwire } from "../types/shared.js";
import type { RequiredInteraction, ToolResult } from "../types/tool.js";
import {
  beginTurn,
  commitCandidate,
  commitFinal,
  commitInput,
  commitToolResults,
} from "../session/state.js";
import { runStep, type LoopAgent } from "../step/run.js";
import { createId } from "../utils/ids.js";
import { copyJson } from "../utils/immutable.js";
import { ToolPlanRunner } from "./plan-runner.js";
import { PromptPrefixState } from "../step/prompt-prefix.js";

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
  readonly onConversation: (event: SessionEvent) => void;
  readonly claimInterrupts: (turnId: string) => readonly InputEvent[];
}

/** Advances one Turn until it finalizes, trips a policy, or pauses for an interaction. */
export class TurnRunner {
  constructor(
    private readonly agent: LoopAgent,
    private readonly sessionId: string,
    private readonly session: Readonly<{ readonly userId?: string; readonly context?: JsonObject }>,
    private readonly prefixState: PromptPrefixState = new PromptPrefixState(),
  ) {}

  async start(
    state: SessionSnapshot,
    event: InputEvent,
    context: TurnRunContext,
  ): Promise<TurnProgress> {
    const turnId = createId("turn");
    const started = beginTurn(state, turnId, event);
    context.onState(started);
    context.onConversation({ type: "input", event, turnId });
    return this.advance(started, turnId, 1, [event], [], context);
  }

  async resume(
    state: SessionSnapshot,
    pending: PendingTurn,
    event: InputEvent,
    context: TurnRunContext,
  ): Promise<TurnProgress> {
    context.onConversation({ type: "input", event, turnId: pending.turnId });
    const progress = await this.runPlan(pending, context, event);
    if (progress.kind === "interaction-required")
      return { kind: "interaction-required", state, pending, interaction: progress.interaction };
    const afterTools = commitToolResults(state, pending.turnId, pending.stepId, progress.results);
    context.onState(afterTools);
    const claimed = claimAndRecord(afterTools, pending.turnId, context);
    return this.advance(
      claimed.state,
      pending.turnId,
      pending.stepNumber + 1,
      claimed.arrivals,
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
        signal: context.signal,
        session: this.session,
        prefixState: this.prefixState,
      });
      context.assertCurrent();
      if (run.candidate) {
        state = commitCandidate(state, turnId, stepId, run.candidate);
        context.onState(state);
        context.onConversation({ type: "candidate", turnId, stepId, candidate: run.candidate });
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
        attributes: {
          executable: Object.freeze(
            run.output.plan.executable.map((entry) =>
              Object.freeze({
                callId: entry.call.callId,
                toolName: entry.call.toolName,
                args: copyJson(entry.call.args),
                executeWith: entry.call.executeWith,
                route: copyJson(entry.call.route),
                invocationId: entry.invocationId,
                ...(entry.preflight === undefined ? {} : { preflight: entry.preflight }),
                ...(entry.interaction === undefined
                  ? {}
                  : { interaction: copyJson(entry.interaction) }),
              }),
            ),
          ),
          immediate: copyJson(run.output.plan.immediateResults),
        },
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
      const claimed = claimAndRecord(state, turnId, context);
      state = claimed.state;
      stepArrivals = claimed.arrivals;
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

function claimAndRecord(
  state: SessionSnapshot,
  turnId: string,
  context: TurnRunContext,
): { readonly state: SessionSnapshot; readonly arrivals: readonly InputEvent[] } {
  const arrivals = context.claimInterrupts(turnId);
  if (arrivals.length === 0) return { state, arrivals };
  let next = state;
  for (const event of arrivals) next = commitInput(next, turnId, event);
  context.onState(next);
  return { state: next, arrivals };
}

import type { InputEvent, InputOptions, SessionEvent, SessionSnapshot } from "../types/session.js";
import type { ObserveEvent, Observer } from "../types/shared.js";
import { createId } from "../utils/ids.js";
import { createEmitter } from "../utils/observe.js";
import {
  InputQueue,
  isInteractionReply,
  snapshotInput,
  watchInputAbort,
  type QueuedInput,
} from "./input-queue.js";
import { SessionEventLog } from "./event-log.js";
import { SubmissionStream } from "./submission-stream.js";
import { commitToolResults, initialState, withStatus } from "./state.js";
import { type LoopAgent } from "../step/run.js";
import { TurnRunner, type PendingTurn, type TurnProgress } from "../turn/runner.js";
import { PromptPrefixState, type PromptPrefixPolicy } from "../step/prompt-prefix.js";

/** Coordinates one active turn at a time; TurnRunner owns the turn's internal state machine. */
export class SessionScheduler {
  readonly events = new SessionEventLog();
  private snapshotValue: SessionSnapshot;
  private readonly queue = new InputQueue();
  private readonly sessionController = new AbortController();
  private activeController?: AbortController;
  private activeSubmission?: QueuedInput;
  private activeWork?: Promise<void>;
  private pending?: PendingTurn;
  private inFlightPlan?: PendingTurn;
  private running = false;
  private stopped = false;
  private generation = 0;
  private stopPromise?: Promise<void>;
  private emitObserve = createEmitter();
  private readonly turns: TurnRunner;
  private readonly prefixState: PromptPrefixState;

  constructor(
    readonly id: string,
    agent: LoopAgent,
    session: Readonly<{
      readonly userId?: string;
      readonly context?: import("../types/shared.js").JsonObject;
    }>,
    prefixPolicy: PromptPrefixPolicy = "observe",
  ) {
    this.snapshotValue = initialState(id);
    this.prefixState = new PromptPrefixState(prefixPolicy, agent.directive);
    this.turns = new TurnRunner(agent, id, session, this.prefixState);
  }

  get snapshot(): SessionSnapshot {
    return this.snapshotValue;
  }

  setObserver(listener: Observer): void {
    this.emitObserve = createEmitter(listener);
  }

  submit(event: InputEvent, options?: InputOptions): SubmissionStream {
    const stream = new SubmissionStream(createId("input"));
    const submission: QueuedInput = {
      event: snapshotInput(event),
      options,
      stream,
      cancelled: false,
    };
    if (this.stopped) return this.finishStopped(stream);
    if (options?.signal?.aborted)
      return this.finishCancelled(stream, cancellationMessage(options.signal));

    if (isInteractionReply(event)) {
      if (!this.enqueueReply(submission, event)) return stream;
    } else this.enqueueOrdinaryInput(submission);
    this.watchAbort(submission);
    this.emitObserve({
      type: "input.received",
      inputId: stream.inputId,
      kind: event.kind,
    });
    this.pump();
    return stream;
  }

  stop(reason = "Session stopped"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.beginStop(reason);
    const activeWork = this.activeWork;
    this.stopPromise = (async () => {
      if (activeWork) await activeWork;
    })();
    return this.stopPromise;
  }

  private enqueueReply(
    submission: QueuedInput,
    reply: Extract<InputEvent, { kind: "approve" | "respond" }>,
  ): boolean {
    if (!this.pending) {
      this.reject(submission.stream, "No interaction is pending");
      return false;
    }
    const expected = this.pending.plan.interactionId;
    if (expected !== reply.interactionId) {
      this.reject(submission.stream, "Interaction id does not match the pending interaction");
      return false;
    }
    if ((this.pending.plan.interactionKind === "approval") !== (reply.kind === "approve")) {
      this.reject(submission.stream, "Interaction input kind does not match");
      return false;
    }
    this.queue.add(submission, true);
    return true;
  }

  private enqueueOrdinaryInput(submission: QueuedInput): void {
    if (this.running || this.pending || this.queue.size) {
      this.publish(submission.stream, {
        type: "input.queued",
        inputId: submission.stream.inputId,
      });
      this.emitObserve({
        type: "input.queued",
        inputId: submission.stream.inputId,
      });
    }
    this.queue.add(submission);
  }

  private watchAbort(submission: QueuedInput): void {
    watchInputAbort(submission, {
      isActive: () => this.activeSubmission === submission,
      abortActive: (reason) => this.activeController?.abort(reason),
      cancelQueued: () => {
        const signal = submission.options?.signal;
        if (signal && this.queue.remove(submission))
          this.finishCancelled(submission.stream, cancellationMessage(signal));
      },
    });
  }

  private reject(stream: SubmissionStream, reason: string): SubmissionStream {
    this.publish(stream, { type: "input.rejected", inputId: stream.inputId, reason });
    this.emitObserve({
      type: "input.rejected",
      inputId: stream.inputId,
      reason,
    });
    stream.finish("rejected");
    return stream;
  }

  private finishCancelled(stream: SubmissionStream, reason: string): SubmissionStream {
    this.publish(stream, { type: "input.cancelled", inputId: stream.inputId, reason });
    this.emitObserve({
      type: "input.cancelled",
      inputId: stream.inputId,
      reason,
    });
    stream.finish("cancelled");
    return stream;
  }

  private finishStopped(stream: SubmissionStream): SubmissionStream {
    this.publish(stream, { type: "session.stopped", sessionId: this.id });
    stream.finish("stopped");
    return stream;
  }

  private publish(stream: SubmissionStream, event: SessionEvent): void {
    stream.emit(event);
    this.events.emit(event);
  }

  private pump(): void {
    if (this.running || this.stopped) return;
    const next = this.queue.take(Boolean(this.pending));
    if (!next) return;
    if (next.cancelled) {
      this.pump();
      return;
    }

    // This Scheduler is the sole serializing point: only one turn can mutate a Session at once.
    this.running = true;
    this.activeSubmission = next;
    this.activeController = new AbortController();
    const generation = ++this.generation;
    const signal = AbortSignal.any([
      this.sessionController.signal,
      this.activeController.signal,
      ...(next.options?.signal ? [next.options.signal] : []),
    ]);
    const work = this.run(next, signal, generation).finally(() => {
      this.running = false;
      this.activeSubmission = undefined;
      this.activeController = undefined;
      if (this.activeWork === work) this.activeWork = undefined;
      if (!this.stopped && !this.pending)
        this.snapshotValue = withStatus(this.snapshotValue, "idle");
      this.pump();
    });
    this.activeWork = work;
    void work;
  }

  private async run(
    submission: QueuedInput,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    try {
      const context = {
        signal,
        observe: (event: ObserveEvent) =>
          this.emitObserve(withInputId(event, submission.stream.inputId)),
        assertCurrent: () => this.assertCurrent(generation, signal),
        onPlanActive: (plan: PendingTurn | undefined) => {
          this.inFlightPlan = plan;
        },
        onState: (state: SessionSnapshot) => {
          this.snapshotValue = state;
        },
        onConversation: (event: SessionEvent) => this.publish(submission.stream, event),
        claimInterrupts: (turnId: string) => this.claimInterrupts(turnId),
      };
      const outcome = this.pending
        ? await this.resumeTurn(submission, context)
        : await this.turns.start(this.snapshotValue, submission.event, context);
      this.applyTurnOutcome(submission.stream, outcome);
    } catch (error) {
      if (this.inFlightPlan) {
        this.commitCancelledPlan(this.inFlightPlan, message(error));
        this.inFlightPlan = undefined;
      }
      if (this.stopped) this.finishStopped(submission.stream);
      else {
        if (!this.pending) this.snapshotValue = withStatus(this.snapshotValue, "idle");
        this.finishCancelled(submission.stream, message(error));
      }
    }
  }

  private async resumeTurn(
    submission: QueuedInput,
    context: Parameters<TurnRunner["resume"]>[3],
  ): Promise<TurnProgress> {
    const pending = this.pending!;
    this.pending = undefined;
    this.snapshotValue = withStatus(this.snapshotValue, "running");
    return this.turns.resume(this.snapshotValue, pending, submission.event, context);
  }

  private applyTurnOutcome(stream: SubmissionStream, outcome: TurnProgress): void {
    switch (outcome.kind) {
      case "final":
        this.snapshotValue = withStatus(outcome.state, "idle");
        this.publish(stream, { type: "final", output: outcome.output, turnId: outcome.turnId });
        this.emitObserve({
          type: "turn.completed",
          turnId: outcome.turnId,
          stepId: outcome.stepId,
          inputId: stream.inputId,
          attributes: { output: outcome.output },
        });
        stream.finish("completed");
        return;
      case "interaction-required":
        this.pending = outcome.pending;
        this.snapshotValue = withStatus(outcome.state, "waiting", outcome.interaction);
        this.emitObserve({
          type: "interaction.required",
          turnId: outcome.pending.turnId,
          stepId: outcome.pending.stepId,
          inputId: stream.inputId,
          interactionId: outcome.interaction.id,
          kind: outcome.interaction.kind,
          ...(outcome.pending.plan.interactionCallId === undefined
            ? {}
            : { callId: outcome.pending.plan.interactionCallId }),
          ...(outcome.pending.plan.interactionToolName === undefined
            ? {}
            : { toolName: outcome.pending.plan.interactionToolName }),
          ...(outcome.pending.plan.interactionPhase === undefined
            ? {}
            : { phase: outcome.pending.plan.interactionPhase }),
          attributes: {
            prompt: outcome.interaction.prompt,
            ...(outcome.interaction.metadata === undefined
              ? {}
              : { metadata: outcome.interaction.metadata }),
          },
        });
        this.publish(stream, {
          type: "interaction.required",
          interaction: outcome.interaction,
          turnId: outcome.pending.turnId,
        });
        stream.finish("waiting");
        return;
      case "tripwire":
        this.snapshotValue = outcome.state;
        this.publish(stream, {
          type: "tripwire",
          tripwire: outcome.tripwire,
          turnId: outcome.turnId,
        });
        this.emitObserve({
          type: "tripwire",
          turnId: outcome.turnId,
          inputId: stream.inputId,
          ...(outcome.stepId ? { stepId: outcome.stepId } : {}),
          code: outcome.tripwire.code,
          scope: outcome.tripwire.scope ?? "step",
          attributes: { message: outcome.tripwire.message },
        });
        if (outcome.tripwire.scope === "session") this.beginStop("Session policy tripwire");
        else this.snapshotValue = withStatus(this.snapshotValue, "idle");
        stream.finish("completed");
    }
  }

  private beginStop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.sessionController.abort(new Error(reason));
    this.activeController?.abort(new Error(reason));
    if (this.pending) this.commitCancelledPlan(this.pending, reason);
    this.pending = undefined;
    this.snapshotValue = withStatus(this.snapshotValue, "stopped");
    this.events.emit({ type: "session.stopped", sessionId: this.id });
    this.events.finish();
    this.emitObserve({ type: "session.stopped", reason });
    for (const item of this.queue.drain()) this.finishStopped(item.stream);
  }

  private commitCancelledPlan(pending: PendingTurn, reason: string): void {
    this.snapshotValue = commitToolResults(
      this.snapshotValue,
      pending.turnId,
      pending.stepId,
      pending.plan.cancelledResults(reason),
    );
  }

  private claimInterrupts(turnId: string): readonly InputEvent[] {
    const claimed = this.queue.takeInterrupts();
    const events: InputEvent[] = [];
    for (const item of claimed) {
      const conversation = Object.freeze({
        type: "input" as const,
        event: item.event,
        turnId,
      });
      this.events.emit(conversation);
      this.activeSubmission?.stream.emit(conversation);
      item.stream.emit(conversation);
      item.stream.finish("completed");
      events.push(item.event);
    }
    return Object.freeze(events);
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    // An abort-ignoring adapter may resolve late; its state must never re-enter this Session.
    if (this.stopped || generation !== this.generation || signal.aborted)
      throw signal.reason ?? new Error("Stale Session result quarantined");
  }
}

function withInputId(event: ObserveEvent, inputId: string): ObserveEvent {
  return "turnId" in event ? { ...event, inputId } : event;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancellationMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : signal.reason
      ? String(signal.reason)
      : "Input cancelled";
}

import type {
  ActiveExecutionRecord,
  InputEvent,
  InputOptions,
  SessionEvent,
  SessionRecord,
  SessionRecorder,
  SessionSnapshot,
} from "../types/session.js";
import type { ObserveEvent, Observer } from "../types/shared.js";
import { HarnessError } from "../errors.js";
import { createId } from "../utils/ids.js";
import { createObserverRegistry, type ObserveEmit } from "../utils/observe.js";
import {
  InputQueue,
  isInteractionReply,
  snapshotWork,
  watchInputAbort,
  type QueuedInput,
  type WorkEvent,
} from "./input-queue.js";
import { SessionEventLog } from "./event-log.js";
import { SubmissionStream } from "./submission-stream.js";
import { commitInput, commitToolResults, initialState, withStatus } from "./state.js";
import { type LoopAgent } from "../build/agent.js";
import { TurnRunner, type PendingTurn, type TurnProgress } from "../turn/runner.js";
import type { NormalizedSessionSeed } from "./seed.js";
import { sessionRecord } from "./record.js";
import { CapabilityStateRegistry } from "./capability-state.js";

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
  private stopping = false;
  private stopped = false;
  private suspended = false;
  private generation = 0;
  private stopPromise?: Promise<void>;
  private recordFailure?: HarnessError;
  private readonly observers = createObserverRegistry();
  private readonly turns: TurnRunner;
  private readonly states: CapabilityStateRegistry;

  constructor(
    readonly id: string,
    agent: LoopAgent,
    session: Readonly<{
      readonly userId?: string;
      readonly context?: import("../types/shared.js").JsonObject;
    }>,
    options: {
      readonly seed?: NormalizedSessionSeed;
      readonly recorder?: SessionRecorder;
    } = {},
  ) {
    this.snapshotValue = initialState(id, options.seed);
    this.turns = new TurnRunner(agent, id, session);
    this.session = session;
    this.recorder = options.recorder;
    this.states = new CapabilityStateRegistry(
      agent.middleware,
      Object.freeze({ id, ...session }),
      (event) => this.emitObserve(event),
    );
    if (options.seed) {
      const event = Object.freeze({
        type: "session.seeded" as const,
        revision: options.seed.revision,
        transcriptEntries: options.seed.transcript.length,
      });
      // Construction precedes public observer registration. Defer this live-only fact
      // by one microtask so callers can subscribe immediately after run({ seed }).
      queueMicrotask(() => {
        if (!this.stopped) this.emitObserve(event);
      });
    }
  }

  private readonly session: Readonly<{
    readonly userId?: string;
    readonly context?: import("../types/shared.js").JsonObject;
  }>;
  private readonly recorder?: SessionRecorder;

  get snapshot(): SessionSnapshot {
    return this.snapshotValue;
  }

  observe(listener: Observer): () => void {
    if (this.stopped) return () => undefined;
    return this.observers.observe(listener);
  }

  submit(event: InputEvent, options?: InputOptions): SubmissionStream {
    return this.submitWork(event, options);
  }

  continue(options?: InputOptions): SubmissionStream {
    return this.submitWork({ kind: "continue" }, options);
  }

  private submitWork(event: WorkEvent, options?: InputOptions): SubmissionStream {
    const stream = new SubmissionStream(createId("input"));
    const submission: QueuedInput = {
      event: snapshotWork(event),
      options,
      stream,
      cancelled: false,
    };
    if (this.stopped) return this.finishStopped(stream);
    if (options?.signal?.aborted)
      return this.finishCancelled(stream, cancellationMessage(options.signal));

    if (event.kind !== "continue" && isInteractionReply(event)) {
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
    this.stopping = true;
    this.generation += 1;
    const stopError = new HarnessError("session.stale-result", reason);
    this.sessionController.abort(stopError);
    this.activeController?.abort(stopError);
    this.states.abort(stopError);
    const activeWork = this.activeWork;
    const activeStream = this.activeSubmission?.stream;
    const pending = this.pending;
    this.pending = undefined;
    this.stopPromise = (async () => {
      if (activeWork) await activeWork;
      if (pending && !this.recordFailure) await this.commitCancelledPlan(pending, reason);
      const stopped = await this.commit(withStatus(this.snapshotValue, "stopped"), "stopped");
      this.snapshotValue = stopped;
      this.stopped = true;
      this.stopping = false;
      const event = { type: "session.stopped" as const, sessionId: this.id };
      this.events.emit(event);
      this.events.finish();
      if (activeStream) {
        activeStream.emit(event);
        activeStream.finish("stopped");
      }
      for (const item of this.queue.drain()) {
        item.stream.emit(event);
        item.stream.finish("stopped");
      }
      this.emitObserve({ type: "session.stopped", reason });
      await this.states.shutdown(stopError);
      this.observers.clear();
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
    if (this.running || this.stopping || this.stopped || this.suspended) return;
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
        states: this.states,
        observe: ((event) =>
          this.emitObserve(() =>
            withInputId(typeof event === "function" ? event() : event, submission.stream.inputId),
          )) satisfies ObserveEmit,
        assertCurrent: () => this.assertCurrent(generation, signal),
        onPlanActive: (plan: PendingTurn | undefined) => {
          this.inFlightPlan = plan;
        },
        commit: (
          state: SessionSnapshot,
          transition: SessionRecord["transition"],
          active?: ActiveExecutionRecord,
        ) =>
          this.commit(state, transition, active).then((committed) => {
            if (transition === "model-requested" && submission.event.kind === "continue")
              this.emitObserve({ type: "session.continued", inputId: submission.stream.inputId });
            return committed;
          }),
        onConversation: (event: SessionEvent) => this.publish(submission.stream, event),
        claimInterrupts: (state: SessionSnapshot, turnId: string) =>
          this.claimInterrupts(state, turnId),
      };
      const outcome = this.pending
        ? await this.resumeTurn(submission, context)
        : submission.event.kind === "continue"
          ? await this.turns.continue(this.snapshotValue, context)
          : await this.turns.start(this.snapshotValue, submission.event, context);
      this.applyTurnOutcome(submission.stream, outcome);
    } catch (error) {
      if (this.inFlightPlan && !this.recordFailure) {
        try {
          await this.commitCancelledPlan(this.inFlightPlan, message(error));
        } catch {
          if (this.recordFailure) return;
        }
        this.inFlightPlan = undefined;
      }
      if (this.recordFailure || this.stopping) return;
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
    if (submission.event.kind === "continue")
      throw new HarnessError(
        "interaction.uncorrelated-resume",
        "Continue cannot answer an interaction",
      );
    return this.turns.resume(
      withStatus(this.snapshotValue, "running"),
      pending,
      submission.event,
      context,
    );
  }

  private applyTurnOutcome(stream: SubmissionStream, outcome: TurnProgress): void {
    switch (outcome.kind) {
      case "final":
        this.snapshotValue = outcome.state;
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
        this.snapshotValue = outcome.state;
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
          phase: "interaction",
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
      case "deferred":
        this.suspended = true;
        this.snapshotValue = outcome.state;
        if (outcome.active.kind === "model")
          this.emitObserve({
            type: "model.deferred",
            turnId: outcome.turnId,
            stepId: outcome.stepId,
            inputId: stream.inputId,
            invocationId: outcome.active.invocationId,
            attributes: outcome.active.token === undefined ? {} : { token: outcome.active.token },
          });
        this.publish(stream, {
          type: "execution.deferred",
          active: outcome.active,
          turnId: outcome.turnId,
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
        if (outcome.tripwire.scope === "session") void this.stop("Session policy tripwire");
        else this.snapshotValue = withStatus(this.snapshotValue, "idle");
        stream.finish("completed");
    }
  }

  private emitObserve(event: ObserveEvent | (() => ObserveEvent)): void {
    this.observers.emit(event);
  }

  private async commitCancelledPlan(pending: PendingTurn, reason: string): Promise<void> {
    this.snapshotValue = await this.commit(
      commitToolResults(
        this.snapshotValue,
        pending.turnId,
        pending.stepId,
        pending.plan.cancelledResults(reason),
      ),
      "tool-results",
    );
  }

  private async claimInterrupts(
    state: SessionSnapshot,
    turnId: string,
  ): Promise<{ readonly state: SessionSnapshot; readonly arrivals: readonly InputEvent[] }> {
    const claimed = this.queue.takeInterrupts();
    const events: InputEvent[] = [];
    let nextState = state;
    for (const item of claimed) {
      nextState = await this.commit(commitInput(nextState, turnId, item.event), "input");
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
    return Object.freeze({ state: nextState, arrivals: Object.freeze(events) });
  }

  private async commit(
    state: SessionSnapshot,
    transition: SessionRecord["transition"],
    active?: ActiveExecutionRecord,
  ): Promise<SessionSnapshot> {
    this.assertRecordable();
    const revision = this.snapshotValue.revision + 1;
    const { active: _oldActive, ...rest } = state;
    const next = Object.freeze({
      ...rest,
      revision,
      ...(state.pendingInteraction === undefined
        ? {}
        : { pendingInteraction: state.pendingInteraction }),
      ...(active === undefined ? {} : { active }),
    }) as SessionSnapshot;
    if (this.recorder) {
      const value = sessionRecord({ state: next, transition, session: this.session, active });
      try {
        await this.recorder.record(value);
      } catch (cause) {
        const error = new HarnessError("session.record-failed", "Session recorder failed", {
          cause,
        });
        this.failRecording(error);
        throw error;
      }
    }
    this.snapshotValue = next;
    return next;
  }

  private assertRecordable(): void {
    if (this.recordFailure) throw this.recordFailure;
    if (this.stopped && !this.stopping)
      throw new HarnessError("session.stale-result", "Stopped Session cannot record state");
  }

  private failRecording(error: HarnessError): void {
    if (this.recordFailure) return;
    this.recordFailure = error;
    this.stopping = false;
    this.stopped = true;
    this.generation += 1;
    this.sessionController.abort(error);
    this.activeController?.abort(error);
    void this.states.shutdown(error);
    this.pending = undefined;
    this.inFlightPlan = undefined;
    this.snapshotValue = withStatus(this.snapshotValue, "stopped");
    this.emitObserve({
      type: "session.record.failed",
      code: error.code,
      attributes: { message: error.message },
    });
    const event = { type: "session.stopped" as const, sessionId: this.id };
    this.events.emit(event);
    this.events.finish();
    this.activeSubmission?.stream.emit(event);
    this.activeSubmission?.stream.fail(error);
    for (const item of this.queue.drain()) {
      item.stream.emit(event);
      item.stream.finish("stopped");
    }
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    // An abort-ignoring model or tool may resolve late; it must never re-enter this Session.
    if (this.stopped || generation !== this.generation || signal.aborted)
      throw (
        signal.reason ??
        new HarnessError("session.stale-result", "Stale Session result quarantined")
      );
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

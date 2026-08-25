import type { InputEvent, InputOptions } from "../types/session.js";
import { copyJson, copyJsonObject } from "../utils/immutable.js";
import { SubmissionStream } from "./submission-stream.js";

export interface QueuedInput {
  readonly event: InputEvent;
  readonly options?: InputOptions;
  readonly stream: SubmissionStream;
  cancelled: boolean;
}

export interface QueueAbortHandlers {
  readonly isActive: () => boolean;
  readonly abortActive: (reason: unknown) => void;
  readonly cancelQueued: () => void;
}

export function isInteractionReply(
  event: InputEvent,
): event is Extract<InputEvent, { kind: "approve" | "respond" }> {
  return event.kind === "approve" || event.kind === "respond";
}

export function snapshotInput(event: InputEvent): InputEvent {
  switch (event.kind) {
    case "user-message":
    case "interrupt":
      return Object.freeze({
        kind: event.kind,
        text: event.text,
        ...(event.metadata ? { metadata: copyJsonObject(event.metadata, "input metadata") } : {}),
      });
    case "approve":
      return Object.freeze({ ...event });
    case "respond":
      return Object.freeze({ ...event, value: copyJson(event.value) });
  }
}

/** Serializes ordinary input while allowing a matching interaction reply to resume immediately. */
export class InputQueue {
  private readonly values: QueuedInput[] = [];

  get size(): number {
    return this.values.length;
  }

  add(input: QueuedInput, priority = false): void {
    if (priority) this.values.unshift(input);
    else this.values.push(input);
  }

  take(waitingForInteraction: boolean): QueuedInput | undefined {
    const next = this.values[0];
    if (!next || (waitingForInteraction && !isInteractionReply(next.event))) return undefined;
    return this.values.shift();
  }

  remove(input: QueuedInput): boolean {
    const index = this.values.indexOf(input);
    if (index < 0) return false;
    this.values.splice(index, 1);
    return true;
  }

  drain(): readonly QueuedInput[] {
    return this.values.splice(0);
  }
}

/** Binds one caller-provided signal to its queue entry and always removes the listener at completion. */
export function watchInputAbort(input: QueuedInput, handlers: QueueAbortHandlers): void {
  const signal = input.options?.signal;
  if (!signal) return;
  const onAbort = () => {
    input.cancelled = true;
    if (handlers.isActive()) handlers.abortActive(signal.reason);
    else handlers.cancelQueued();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  input.stream.onFinish(() => signal.removeEventListener("abort", onAbort));
}

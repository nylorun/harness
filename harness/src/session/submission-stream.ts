import type { InputCompletion, InputHandle, SessionEvent } from "../types/session.js";

export class SubmissionStream implements InputHandle {
  readonly completed: Promise<InputCompletion>;
  private resolveCompletion!: (value: InputCompletion) => void;
  private rejectCompletion!: (reason: unknown) => void;
  private readonly events: SessionEvent[] = [];
  private readonly cleanups: (() => void)[] = [];
  private done = false;

  constructor(readonly inputId: string) {
    this.completed = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
  }

  emit(event: SessionEvent): void {
    if (!this.done) this.events.push(event);
  }

  finish(status: InputCompletion["status"]): void {
    if (this.done) return;
    this.done = true;
    while (this.cleanups.length) this.cleanups.pop()!();
    this.resolveCompletion(
      Object.freeze({
        inputId: this.inputId,
        status,
        events: Object.freeze([...this.events]),
      }),
    );
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    while (this.cleanups.length) this.cleanups.pop()!();
    this.rejectCompletion(error);
  }

  onFinish(cleanup: () => void): void {
    if (this.done) cleanup();
    else this.cleanups.push(cleanup);
  }
}

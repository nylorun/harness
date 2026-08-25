import type { SessionEvent } from "../types/session.js";

/** Session-lifetime conversation log. Each stream() call replays from the start. */
export class SessionEventLog implements AsyncIterable<SessionEvent> {
  private readonly events: SessionEvent[] = [];
  private readonly subscribers: (() => void)[][] = [];
  private done = false;

  emit(event: SessionEvent): void {
    if (this.done) return;
    this.events.push(event);
    this.wake();
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.wake();
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    let index = 0;
    const waiting: (() => void)[] = [];
    this.subscribers.push(waiting);
    const pull = (): Promise<IteratorResult<SessionEvent>> => {
      if (index < this.events.length)
        return Promise.resolve({ done: false, value: this.events[index++]! });
      if (this.done) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => {
        waiting.push(() => {
          void pull().then(resolve);
        });
      });
    };
    return { next: pull };
  }

  private wake(): void {
    for (const waiting of this.subscribers) {
      while (waiting.length) waiting.shift()!();
    }
  }
}

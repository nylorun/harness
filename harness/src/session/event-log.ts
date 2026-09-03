import type { SessionEvent } from "../types/session.js";
import type { JsonValue } from "../types/shared.js";

/** Session-lifetime conversation log. Each stream() call replays from the start. */
export class SessionEventLog implements AsyncIterable<SessionEvent<JsonValue>> {
  private readonly events: SessionEvent<JsonValue>[] = [];
  private readonly subscribers: (() => void)[][] = [];
  private done = false;

  emit(event: SessionEvent<JsonValue>): void {
    if (this.done) return;
    this.events.push(event);
    this.wake();
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.wake();
    this.subscribers.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent<JsonValue>> {
    let index = 0;
    let closed = false;
    const waiting: (() => void)[] = [];
    this.subscribers.push(waiting);
    const detach = (): void => {
      const position = this.subscribers.indexOf(waiting);
      if (position !== -1) this.subscribers.splice(position, 1);
    };
    const complete = (): IteratorResult<SessionEvent<JsonValue>> => {
      closed = true;
      detach();
      return { done: true, value: undefined };
    };
    const pull = (): Promise<IteratorResult<SessionEvent<JsonValue>>> => {
      if (closed) return Promise.resolve({ done: true, value: undefined });
      if (index < this.events.length)
        return Promise.resolve({ done: false, value: this.events[index++]! });
      if (this.done) return Promise.resolve(complete());
      return new Promise((resolve) => {
        waiting.push(() => {
          void pull().then(resolve);
        });
      });
    };
    return {
      next: pull,
      return: () => {
        const result = complete();
        while (waiting.length) waiting.shift()!();
        return Promise.resolve(result);
      },
    };
  }

  private wake(): void {
    for (const waiting of this.subscribers) {
      while (waiting.length) waiting.shift()!();
    }
  }
}

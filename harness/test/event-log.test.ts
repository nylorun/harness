import { describe, expect, it } from "vitest";
import { SessionEventLog } from "../src/session/event-log.js";
import type { SessionEvent } from "../src/types/session.js";

function subscriberCount(log: SessionEventLog): number {
  return (log as unknown as { subscribers: unknown[] }).subscribers.length;
}

function stopped(sessionId = "session"): SessionEvent {
  return { type: "session.stopped", sessionId };
}

describe("SessionEventLog", () => {
  it("does not retain subscribers after a stream completes, returns, or finish()", async () => {
    const replay = new SessionEventLog();
    replay.emit(stopped());
    replay.finish();
    const first: string[] = [];
    for await (const event of replay) first.push(event.type);
    const second: string[] = [];
    for await (const event of replay) second.push(event.type);
    expect(first).toEqual(["session.stopped"]);
    expect(second).toEqual(first);
    expect(subscriberCount(replay)).toBe(0);

    const live = new SessionEventLog();
    live.emit(stopped("a"));
    live.emit(stopped("b"));
    for await (const event of live) {
      expect(event.type).toBe("session.stopped");
      break;
    }
    expect(subscriberCount(live)).toBe(0);

    const waiting = new SessionEventLog();
    const iterator = waiting[Symbol.asyncIterator]();
    const pending = iterator.next();
    expect(subscriberCount(waiting)).toBe(1);
    waiting.finish();
    expect((await pending).done).toBe(true);
    expect(subscriberCount(waiting)).toBe(0);
  });
});

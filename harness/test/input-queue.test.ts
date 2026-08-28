import { describe, expect, it, vi } from "vitest";
import { InputQueue, watchInputAbort, type QueuedInput } from "../src/session/input-queue.js";
import { SubmissionStream } from "../src/session/submission-stream.js";

function input(id: string, kind: QueuedInput["event"]["kind"] = "user-message"): QueuedInput {
  const event =
    kind === "approve"
      ? ({ kind, interactionId: "approval", approved: true } as const)
      : ({ kind, text: id } as const);
  return { event, stream: new SubmissionStream(id), cancelled: false };
}

describe("InputQueue", () => {
  it("keeps ordinary input FIFO but prioritizes an interaction reply while waiting", () => {
    const queue = new InputQueue();
    const first = input("first");
    const second = input("second");
    const approval = input("approval", "approve");
    queue.add(first);
    queue.add(second);
    queue.add(approval, true);

    expect(queue.take(true)).toBe(approval);
    expect(queue.take(false)).toBe(first);
    expect(queue.take(false)).toBe(second);
  });

  it("claims queued interrupts in order and leaves other kinds in place", () => {
    const queue = new InputQueue();
    const first = input("first");
    const steer = input("steer", "interrupt");
    const second = input("second");
    const again = input("again", "interrupt");
    const cancelled = input("cancelled", "interrupt");
    cancelled.cancelled = true;
    const approval = input("approval", "approve");
    queue.add(first);
    queue.add(steer);
    queue.add(second);
    queue.add(cancelled);
    queue.add(again);
    queue.add(approval);

    expect(queue.takeInterrupts().map((item) => item.event)).toEqual([
      { kind: "interrupt", text: "steer" },
      { kind: "interrupt", text: "again" },
    ]);
    expect(queue.take(false)?.event).toEqual({ kind: "user-message", text: "first" });
    expect(queue.take(false)?.event).toEqual({ kind: "user-message", text: "second" });
    expect(queue.take(false)?.event).toEqual({
      kind: "approve",
      interactionId: "approval",
      approved: true,
    });
    expect(queue.take(false)).toBeUndefined();
  });

  it("marks a queued input cancelled and removes its abort listener when the stream finishes", () => {
    const controller = new AbortController();
    const queued: QueuedInput = { ...input("queued"), options: { signal: controller.signal } };
    const cancelQueued = vi.fn();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    watchInputAbort(queued, { isActive: () => false, abortActive: vi.fn(), cancelQueued });

    controller.abort(new Error("not needed"));
    expect(queued.cancelled).toBe(true);
    expect(cancelQueued).toHaveBeenCalledOnce();
    queued.stream.finish("cancelled");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

import { describe, expect, it } from "vitest";
import { activitiesForEvents, eventLabel, eventSummary, type CanonicalEvent } from "./event-presentation";

const event = (type: string, payload: Record<string, unknown>, seq = 1): CanonicalEvent => ({ session: "session-1", seq, ts: "2026-08-30T00:00:00.000Z", type, payload });

describe("Studio event presentation", () => {
  it("summarizes successful and failed Harness tool outcomes", () => {
    expect(eventSummary(event("tool.completed", { toolName: "calculate", outcome: "completed", attributes: { kind: "completed", output: { value: 4 } } }))).toBe('calculate: {"value":4}');
    expect(eventSummary(event("tool.completed", { toolName: "write_note", outcome: "failed", attributes: { kind: "failed", message: "Disk full" } }))).toBe("write_note: Disk full");
  });

  it("renders the approval lifecycle from canonical events", () => {
    const activities = activitiesForEvents([
      event("interaction.required", { interaction: { prompt: "Save this note?" } }, 1),
      event("session.run.started", { input_kind: "approve", approved: true }, 2),
    ]);
    expect(activities).toEqual([
      expect.objectContaining({ title: "Waiting for approval", state: "waiting" }),
      expect.objectContaining({ title: "Approval granted", state: "approved" }),
    ]);
  });

  it("uses readable event labels", () => {
    expect(eventLabel(event("tool.completed", {}))).toBe("Tool completed");
    expect(eventLabel(event("custom.event", {}))).toBe("custom event");
  });
});

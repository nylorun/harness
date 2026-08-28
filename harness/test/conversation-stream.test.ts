import { describe, expect, it } from "vitest";
import { Agent, type SessionEvent } from "../src/index.js";
import { adapter, offer, model, tool } from "./fixtures.js";

describe("conversation stream", () => {
  it("streams input and per-step candidates without tool results", async () => {
    let calls = 0;
    const result = Agent(
      model(async () => {
        calls += 1;
        if (calls === 1)
          return {
            output: [
              { type: "text" as const, text: "I'll look that up." },
              {
                type: "tool-call" as const,
                id: "c1",
                name: "lookup_order",
                args: { orderId: "1842" },
              },
            ],
          };
        if (calls === 2) return "Order 1842 is out for delivery. Thursday.";
        if (calls === 3)
          return {
            output: [
              { type: "text" as const, text: "I can issue that refund." },
              {
                type: "tool-call" as const,
                id: "c2",
                name: "issue_refund",
                args: { orderId: "1842", amount: 84 },
              },
            ],
          };
        return "Refund of $84 is on the way.";
      }),
    )
      .with(adapter())
      .use("approval", async (_request, next) => {
        const response = await next();
        if (response.toolCalls().some((call) => call.id === "c2")) {
          response.requireInteraction("c2", {
            kind: "approval",
            prompt: "Refund $84 on 1842?",
          });
        }
        return response;
      })
      .use("tools", offer(tool("lookup_order"), tool("issue_refund")))
      .build();

    const session = result.run();
    const conversation = (events: readonly SessionEvent[]) =>
      events.filter((event) => event.type !== "input.queued");

    const lookup = await session.input("Where is order 1842?").completed;
    expect(conversation(lookup.events)).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "Where is order 1842?" } },
      {
        type: "candidate",
        candidate: {
          output: [
            { type: "text", text: "I'll look that up." },
            { type: "tool-call", id: "c1", name: "lookup_order", args: { orderId: "1842" } },
          ],
        },
      },
      {
        type: "candidate",
        candidate: {
          output: [{ type: "text", text: "Order 1842 is out for delivery. Thursday." }],
        },
      },
      { type: "final", output: "Order 1842 is out for delivery. Thursday." },
    ]);

    const refund = await session.input("Refund it.").completed;
    expect(refund.status).toBe("waiting");
    const required = refund.events.find((event) => event.type === "interaction.required");
    if (!required || required.type !== "interaction.required")
      throw new Error("missing interaction");
    expect(conversation(refund.events)).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "Refund it." } },
      {
        type: "candidate",
        candidate: {
          output: [
            { type: "text", text: "I can issue that refund." },
            {
              type: "tool-call",
              id: "c2",
              name: "issue_refund",
              args: { orderId: "1842", amount: 84 },
            },
          ],
        },
      },
      { type: "interaction.required", interaction: { prompt: "Refund $84 on 1842?" } },
    ]);

    const approved = await session.input({
      kind: "approve",
      interactionId: required.interaction.id,
      approved: true,
    }).completed;
    expect(conversation(approved.events)).toMatchObject([
      { type: "input", event: { kind: "approve", approved: true } },
      {
        type: "candidate",
        candidate: { output: [{ type: "text", text: "Refund of $84 is on the way." }] },
      },
      { type: "final", output: "Refund of $84 is on the way." },
    ]);

    await session.stop();
    const streamed: SessionEvent[] = [];
    for await (const event of session.stream()) streamed.push(event);
    expect(conversation(streamed).map((event) => event.type)).toEqual([
      "input",
      "candidate",
      "candidate",
      "final",
      "input",
      "candidate",
      "interaction.required",
      "input",
      "candidate",
      "final",
      "session.stopped",
    ]);
    expect(streamed.map((event) => event.type)).not.toContain("tool-results");
    expect(session.state.transcript.some((entry) => entry.kind === "tool-results")).toBe(true);
  });
});

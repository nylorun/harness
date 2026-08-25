import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import { model, turn } from "./fixtures.js";

describe("Session isolation", () => {
  it("keeps parallel transcripts, queues, IDs, and outputs isolated", async () => {
    const result = Agent(
      model(async (request) => {
        await Promise.resolve();
        return `${request.sessionId}:${request.arrivals[0]?.kind === "user-message" ? request.arrivals[0].text : ""}`;
      }),
    ).build();
    const started = Array.from({ length: 40 }, (_, index) =>
      turn(result, `message-${index}`, { id: `session-${index}` }),
    );
    const sessions = started.map((item) => item.session);
    const completions = await Promise.all(started.map((item) => item.handle.completed));
    completions.forEach((completion, index) =>
      expect(completion.events.at(-1)).toMatchObject({
        type: "final",
        output: `session-${index}:message-${index}`,
      }),
    );
    for (let index = 0; index < sessions.length; index += 1) {
      const serialized = JSON.stringify(sessions[index]!.state.transcript);
      expect(serialized).toContain(`message-${index}`);
      expect(serialized).not.toContain(`message-${(index + 1) % sessions.length}`);
    }
    expect(
      new Set(
        sessions.map(
          (session) => session.state.transcript.find((entry) => entry.kind === "candidate")?.stepId,
        ),
      ).size,
    ).toBe(40);
    await Promise.all(sessions.map((session) => session.stop()));
  });
});

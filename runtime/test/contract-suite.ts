import { describe, expect, it } from "vitest";
import type { RuntimeAgent, RuntimeModelAdapter } from "../src/contracts.js";
import { memoryHistory } from "../src/adapters/journal.js";
import { Runtime, serveAgents } from "../src/server/host.js";

function isolated(agent: RuntimeAgent, onModelCall?: RuntimeModelAdapter) {
  const runtime = new Runtime({
    observer: () => {},
    durability: memoryHistory(),
    ...(onModelCall === undefined ? {} : { onModelCall }),
  });
  return { runtime, app: serveAgents({ agents: [agent], runtime }) };
}

/** Both the independent fixture and an external engine run these same assertions. */
export function agentContract(
  name: string,
  factory: (interaction?: "approval" | "response") => RuntimeAgent,
  model?: (interaction?: "approval" | "response") => RuntimeModelAdapter,
) {
  describe(`${name}: portable hosting contract`, () => {
    it("discovers neutral identity, records ordered lifecycle events, and preserves conversation history", async () => {
      const { runtime, app } = isolated(factory(), model?.());
      try {
        const manifest = await (
          await app.request("http://local/echo/manifest.json")
        ).json();
        expect(manifest).toMatchObject({
          protocolVersion: 2,
          id: "echo",
          manifest: { id: "echo", name: "Echo" },
        });
        expect(manifest).not.toHaveProperty("harness");
        for (const content of ["first", "second"]) {
          const result = await app.request(
            "http://local/echo/v1/ag-ui",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                threadId: "conversation",
                messages: [{ role: "user", content }],
              }),
            },
          );
          expect(result.status).toBe(200);
          expect(await result.text()).toContain("RUN_FINISHED");
        }
        const events = await (
          await app.request(
            "http://local/echo/v1/sessions/conversation/events",
          )
        ).json();
        expect(events.events.map((e: { seq: number }) => e.seq)).toEqual(
          events.events.map((_: unknown, i: number) => i + 1),
        );
        expect(
          events.events.filter((e: { type: string }) => e.type === "final"),
        ).toHaveLength(2);
        const history = await (
          await app.request(
            "http://local/echo/v1/ag-ui/sessions/conversation",
          )
        ).json();
        expect(history.messages).toHaveLength(4);
        expect(
          (
              await app.request(
              "http://local/missing/manifest.json",
            )
          ).status,
        ).toBe(404);
      } finally {
        await runtime.close();
      }
    });
    it.each(["approval", "response"] as const)(
      "resumes a %s interaction through the portable contract",
      async (kind) => {
        const { runtime, app } = isolated(factory(kind), model?.(kind));
        try {
          await app.request("http://local/echo/v1/ag-ui", {
            method: "POST",
            body: JSON.stringify({
              threadId: "waiting",
              messages: [{ role: "user", content: "please wait" }],
            }),
          });
          const session = await (
            await app.request(
              "http://local/echo/v1/sessions/waiting",
            )
          ).json();
          expect(session.state).toBe("waiting");
          expect(session.pending_interaction.kind).toBe(kind);
          const interaction =
            kind === "approval"
              ? {
                  id: session.pending_interaction.id,
                  kind: "approval",
                  approved: true,
                }
              : {
                  id: session.pending_interaction.id,
                  kind: "respond",
                  value: "answer",
                };
          const reply = await app.request(
            "http://local/echo/v1/sessions/waiting",
            { method: "POST", body: JSON.stringify({ interaction }) },
          );
          expect(reply.status).toBe(202);
          expect(await reply.json()).toMatchObject({ state: "completed" });
          const stale = await app.request(
            "http://local/echo/v1/sessions/waiting",
            { method: "POST", body: JSON.stringify({ interaction }) },
          );
          expect(stale.status).toBe(409);
        } finally {
          await runtime.close();
        }
      },
    );
  });
}

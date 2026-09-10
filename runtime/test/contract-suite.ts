import { describe, expect, it } from "vitest";
import type { RuntimeAgent } from "../src/contracts.js";
import { createRuntime } from "../src/server/host.js";

/** Both the independent fixture and an external engine run these same assertions. */
export function agentContract(
  name: string,
  factory: (interaction?: "approval" | "response") => RuntimeAgent,
) {
  describe(`${name}: portable hosting contract`, () => {
    it("discovers neutral identity, records ordered lifecycle events, and preserves conversation history", async () => {
      const runtime = await createRuntime({ agents: [factory()] });
      try {
        const manifest = await (
          await runtime.app.request("http://local/agents/echo/manifest.json")
        ).json();
        expect(manifest).toMatchObject({
          protocolVersion: 2,
          id: "echo",
          manifest: { id: "echo", name: "Echo" },
        });
        expect(manifest).not.toHaveProperty("harness");
        for (const content of ["first", "second"]) {
          const result = await runtime.app.request(
            "http://local/agents/echo/v1/ag-ui",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: "http://localhost:1234",
              },
              body: JSON.stringify({
                threadId: "conversation",
                messages: [{ role: "user", content }],
              }),
            },
          );
          expect(result.status).toBe(200);
          expect(result.headers.get("access-control-allow-origin")).toBe(
            "http://localhost:1234",
          );
          expect(await result.text()).toContain("RUN_FINISHED");
        }
        const events = await (
          await runtime.app.request(
            "http://local/agents/echo/v1/sessions/conversation/events",
          )
        ).json();
        expect(events.events.map((e: { seq: number }) => e.seq)).toEqual(
          events.events.map((_: unknown, i: number) => i + 1),
        );
        expect(
          events.events.filter((e: { type: string }) => e.type === "final"),
        ).toHaveLength(2);
        const history = await (
          await runtime.app.request(
            "http://local/agents/echo/v1/ag-ui/sessions/conversation",
          )
        ).json();
        expect(history.messages).toHaveLength(4);
        expect(runtime.hasSession("echo", "conversation")).toBe(true);
        expect(
          (
            await runtime.app.request(
              "http://local/agents/missing/manifest.json",
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
        const runtime = await createRuntime({ agents: [factory(kind)] });
        try {
          await runtime.app.request("http://local/agents/echo/v1/ag-ui", {
            method: "POST",
            body: JSON.stringify({
              threadId: "waiting",
              messages: [{ role: "user", content: "please wait" }],
            }),
          });
          const session = await (
            await runtime.app.request(
              "http://local/agents/echo/v1/sessions/waiting",
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
          const reply = await runtime.app.request(
            "http://local/agents/echo/v1/sessions/waiting",
            { method: "POST", body: JSON.stringify({ interaction }) },
          );
          expect(reply.status).toBe(202);
          expect(await reply.json()).toMatchObject({ state: "completed" });
          const stale = await runtime.app.request(
            "http://local/agents/echo/v1/sessions/waiting",
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

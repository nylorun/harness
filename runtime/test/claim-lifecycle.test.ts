import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import { startRuntime } from "../src/core/runtime.js";

it("lets an agent executor finish an older action and fails a schema-breaking result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claim-lifecycle-"));
  const agent = Agent({ id: "issue", name: "Issue" })
    .use({
      id: "notes",
      tools: [
        tool({
          name: "save",
          input: z.object({ note: z.string() }),
          output: z.object({ saved: z.literal(true) }),
          async run() {
            return { saved: true as const };
          },
        }),
      ],
    })
    .build();
  const runtime = await startRuntime({
    sqlitePath: join(directory, "runtime.sqlite"),
    serverToken: "server-token-value",
    executors: [
      {
        token: "executor-token-value",
        agentId: "issue",
        manifestHash: "not-the-registered-digest",
        implementationVersion: "dev",
      },
    ],
    model: async (effect) => {
      const call = effect.input as { prompt?: { kind?: string }[] };
      if (call.prompt?.at(-1)?.kind === "tool-result")
        return { output: [{ type: "text", text: "done" }] };
      return {
        output: [
          {
            type: "tool-call",
            id: "call-1",
            name: "save",
            args: { note: "hi" },
          },
        ],
      };
    },
    port: 0,
  });
  const server = {
    authorization: "Bearer server-token-value",
    "content-type": "application/json",
  };
  const executor = {
    authorization: "Bearer executor-token-value",
    "content-type": "application/json",
  };
  try {
    const registered = await fetch(`${runtime.url}/v1/agents/issue`, {
      method: "PUT",
      headers: server,
      body: JSON.stringify({
        requestId: "put-1",
        manifest: agent.manifest,
        implementationVersion: "dev",
      }),
    });
    expect(registered.ok).toBe(true);
    const definition = (await registered.json()) as { manifestHash: string };
    expect(definition.manifestHash).not.toBe("not-the-registered-digest");

    const session = await fetch(`${runtime.url}/v1/sessions/s1`, {
      method: "PUT",
      headers: server,
      body: JSON.stringify({
        requestId: "session-1",
        agentId: "issue",
        ownerUserId: "user",
      }),
    });
    expect(session.ok).toBe(true);

    const message = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: server,
      body: JSON.stringify({
        type: "message",
        requestId: "msg-1",
        idempotencyKey: "msg-1",
        content: "save a note",
      }),
    });
    expect(message.ok).toBe(true);

    let pending: {
      actionId: string;
      manifestHash: string;
      outputSchema?: { type?: string };
    }[] = [];
    for (let attempt = 0; attempt < 100 && pending.length === 0; attempt += 1) {
      const listed = await fetch(`${runtime.url}/v1/actions`, {
        headers: { authorization: executor.authorization },
      });
      expect(listed.ok).toBe(true);
      pending = ((await listed.json()) as { actions: typeof pending }).actions;
      if (!pending.length) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]?.manifestHash).toBe(definition.manifestHash);
    expect(pending[0]?.outputSchema).toMatchObject({ type: "object" });

    const claim = await fetch(
      `${runtime.url}/v1/actions/${pending[0]!.actionId}/claim`,
      {
        method: "POST",
        headers: executor,
        body: JSON.stringify({
          requestId: "claim-1",
          implementationVersion: "fixed",
        }),
      },
    );
    expect(claim.ok).toBe(true);
    const claimed = (await claim.json()) as {
      claimId: string;
      generation: number;
    };

    const result = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: executor,
      body: JSON.stringify({
        type: "action_result",
        requestId: "result-1",
        idempotencyKey: "result-1",
        actionId: pending[0]!.actionId,
        claimId: claimed.claimId,
        generation: claimed.generation,
        outcome: { value: { saved: false } },
      }),
    });
    expect(result.ok).toBe(true);

    const items = await fetch(`${runtime.url}/v1/sessions/s1/items`, {
      headers: { authorization: server.authorization },
    });
    expect(items.ok).toBe(true);
    const history = (await items.json()) as {
      items: { type: string; payload: { result?: unknown } }[];
    };
    const completed = history.items.find((item) => item.type === "action.completed");
    expect(completed?.payload.result).toMatchObject({
      kind: "failed",
      code: "tool.invalid-output",
    });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

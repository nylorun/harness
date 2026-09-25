import { expect, it } from "vitest";
import {
  Agent,
  SANDBOX_INSTRUCTIONS,
  createSandboxTools,
} from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
import type { ModelProvider } from "../src/core/provider.js";

const APP = "server-token-value-aaaaaaaa";
const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};
const executorHeaders = {
  authorization: "Bearer executor-token-value",
  "content-type": "application/json",
};

const sandboxed = (id: string, image = "node:22") =>
  Agent({ id, name: id })
    .use({
      id: "sandbox",
      instructions: [SANDBOX_INSTRUCTIONS],
      tools: createSandboxTools(),
      sandbox: { image, idle: "15m" },
    })
    .build();

async function boot(modelProvider?: ModelProvider) {
  return startTestTenant({
    mode: "test",
    applicationKey: APP,
    executors: [
      {
        token: "executor-token-value",
        agentId: "coder",
        implementationVersion: "dev",
      },
    ],
    vaultKek: null,
    modelProvider:
      modelProvider ??
      (async () => ({ output: [{ type: "text", text: "ok" }] })),
    sandbox: { backend: "virtual" },
  });
}

async function putAgent(
  runtime: { url: string },
  agent: { id: string; manifest: unknown }
) {
  const response = await fetch(`${runtime.url}/v1/agents/${agent.id}`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({
      requestId: `put-${agent.id}`,
      manifest: agent.manifest,
      implementationVersion: "dev",
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
}

it("attaches PutSession.sandbox and keys the sandbox by the owning session", async () => {
  const runtime = await boot();
  try {
    const owner = sandboxed("owner");
    const child = sandboxed("child");
    await putAgent(runtime, owner);
    await putAgent(runtime, child);

    const ownerSession = await fetch(`${runtime.url}/v1/sessions/wf-1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "sess-owner",
        agentId: "owner",
        ownerUserId: "ada",
      }),
    });
    expect(ownerSession.ok).toBe(true);

    const shared = await fetch(`${runtime.url}/v1/sessions/agent-1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "sess-child",
        agentId: "child",
        ownerUserId: "ada",
        sandbox: { session: "wf-1" },
      }),
    });
    expect(shared.ok, await shared.clone().text()).toBe(true);
    const view = (await shared.json()) as { sandboxOwnerId: string | null };
    expect(view.sandboxOwnerId).toBe("wf-1");

    const write = await fetch(`${runtime.url}/v1/sessions/wf-1/sandbox/write`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        path: "shared.txt",
        content: "from-owner",
      }),
    });
    expect(write.ok, await write.clone().text()).toBe(true);

    const read = await fetch(
      `${runtime.url}/v1/sessions/agent-1/sandbox/read`,
      {
        method: "POST",
        headers: serverHeaders,
        body: JSON.stringify({ path: "shared.txt" }),
      }
    );
    expect(read.ok, await read.clone().text()).toBe(true);
    const body = (await read.json()) as {
      kind: string;
      output: string;
    };
    expect(body.kind).toBe("completed");
    expect(body.output).toContain("from-owner");
  } finally {
    await runtime.close();
  }
});

it("refuses session sandbox tools while an agent turn is active", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = await boot(async () => {
    await gate;
    return { output: [{ type: "text", text: "done" }] };
  });
  try {
    const owner = sandboxed("owner");
    await putAgent(runtime, owner);
    await fetch(`${runtime.url}/v1/sessions/s1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "s1",
        agentId: "owner",
        ownerUserId: "ada",
      }),
    });
    const message = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        content: "go",
      }),
    });
    expect(message.ok).toBe(true);

    for (let i = 0; i < 40; i++) {
      const session = (await (
        await fetch(`${runtime.url}/v1/sessions/s1`, { headers: serverHeaders })
      ).json()) as { activeTurnId: string | null };
      if (session.activeTurnId) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const refused = await fetch(`${runtime.url}/v1/sessions/s1/sandbox/bash`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({ command: "echo hi" }),
    });
    expect(refused.status).toBe(409);
    release();
  } finally {
    release();
    await runtime.close();
  }
});

it("rejects PutSession.sandbox when specs differ or owners differ", async () => {
  const runtime = await boot();
  try {
    await putAgent(runtime, sandboxed("owner", "node:22"));
    await putAgent(runtime, sandboxed("other", "node:24"));
    await fetch(`${runtime.url}/v1/sessions/wf-1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "owner",
        agentId: "owner",
        ownerUserId: "ada",
      }),
    });

    const mismatch = await fetch(`${runtime.url}/v1/sessions/bad-spec`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "bad-spec",
        agentId: "other",
        ownerUserId: "ada",
        sandbox: { session: "wf-1" },
      }),
    });
    expect(mismatch.status).toBe(409);

    const foreign = await fetch(`${runtime.url}/v1/sessions/bad-owner`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "bad-owner",
        agentId: "owner",
        ownerUserId: "bob",
        sandbox: { session: "wf-1" },
      }),
    });
    expect(foreign.status).toBe(403);
  } finally {
    await runtime.close();
  }
});

it("authorizes claim-scoped POST /v1/actions/:id/sandbox/:tool", async () => {
  const { tool } = await import("@nylorun/core/define");
  const { z } = await import("zod");
  const agent = Agent({ id: "coder", name: "Coder" })
    .use({
      id: "sandbox",
      instructions: [SANDBOX_INSTRUCTIONS],
      tools: createSandboxTools(),
      sandbox: { image: "node:22", idle: "15m" },
    })
    .use({
      id: "work",
      tools: [
        tool({
          name: "note",
          input: z.object({ text: z.string() }),
          async run() {
            return { ok: true };
          },
        }),
      ],
    })
    .build();

  const runtime = await boot(async () => ({
    output: [
      {
        type: "tool-call",
        id: "call-1",
        name: "note",
        args: { text: "hi" },
      },
    ],
  }));
  try {
    await putAgent(runtime, agent);
    await fetch(`${runtime.url}/v1/sessions/s1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "s1",
        agentId: "coder",
        ownerUserId: "ada",
      }),
    });
    await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        content: "note",
      }),
    });

    let actionId: string | undefined;
    for (let i = 0; i < 80; i++) {
      const listed = (await (
        await fetch(`${runtime.url}/v1/actions`, { headers: executorHeaders })
      ).json()) as { actions: { actionId: string }[] };
      if (listed.actions[0]) {
        actionId = listed.actions[0].actionId;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(actionId).toBeTruthy();

    const claimed = (await (
      await fetch(`${runtime.url}/v1/actions/${actionId}/claim`, {
        method: "POST",
        headers: executorHeaders,
        body: JSON.stringify({
          requestId: "claim-1",
          implementationVersion: "dev",
        }),
      })
    ).json()) as { claimId: string; generation: number };

    const write = await fetch(
      `${runtime.url}/v1/actions/${actionId}/sandbox/write`,
      {
        method: "POST",
        headers: executorHeaders,
        body: JSON.stringify({
          claimId: claimed.claimId,
          generation: claimed.generation,
          path: "claim.txt",
          content: "ok",
        }),
      }
    );
    expect(write.ok, await write.clone().text()).toBe(true);
    const written = (await write.json()) as { kind: string };
    expect(written.kind).toBe("completed");

    const stale = await fetch(
      `${runtime.url}/v1/actions/${actionId}/sandbox/bash`,
      {
        method: "POST",
        headers: executorHeaders,
        body: JSON.stringify({
          claimId: "wrong",
          generation: claimed.generation,
          command: "echo no",
        }),
      }
    );
    expect(stale.status).toBe(409);
  } finally {
    await runtime.close();
  }
});

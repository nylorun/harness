import { expect, it } from "vitest";
import { agentContract } from "./contract-suite.js";
import { createRuntime } from "../src/server/host.js";
import type { RuntimeAgent, RuntimeEvent } from "../src/contracts.js";

function engine(
  onStop = () => {},
  onClose = async () => {},
  interaction?: "approval" | "response",
): RuntimeAgent {
  return {
    id: "echo",
    name: "Echo",
    manifest: { id: "echo", name: "Echo" },
    close: onClose,
    run({ id = "session" } = {}) {
      return {
        id,
        input(input) {
          const event =
            typeof input === "string"
              ? { kind: "user-message" as const, text: input }
              : "content" in input
                ? { kind: "user-message" as const, content: input.content }
                : { kind: "user-message" as const, text: "hello" };
          if (interaction && !(typeof input === "object" && "kind" in input)) {
            return {
              completed: Promise.resolve({
                status: "waiting" as const,
                events: [
                  {
                    type: "interaction.required",
                    interaction: {
                      id: "question",
                      kind: interaction,
                      prompt: "confirm",
                    },
                  },
                ],
              }),
            };
          }
          const events: RuntimeEvent[] = [
            { type: "input", event },
            { type: "final", output: "hello" },
          ];
          return {
            completed: Promise.resolve({
              status: "completed" as const,
              events,
            }),
          };
        },
        async *stream() {},
        observe() {
          return () => {};
        },
        async stop() {
          onStop();
        },
      };
    },
  };
}
agentContract("Independent engine", (kind) =>
  engine(undefined, undefined, kind),
);
it("stops sessions and then closes agent resources", async () => {
  const steps: string[] = [];
  const runtime = await createRuntime({
    agents: [
      engine(
        () => steps.push("session"),
        async () => {
          steps.push("agent");
        },
      ),
    ],
  });
  await runtime.app.request("http://local/agents/echo/v1/ag-ui", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  await runtime.close();
  expect(steps).toEqual(["session", "agent"]);
});
it("rejects duplicate identities", async () => {
  await expect(createRuntime({ agents: [engine(), engine()] })).rejects.toThrow(
    "unique",
  );
});

it("persists history across restarts without overwriting archived session events", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localJsonl } = await import("../src/adapters/journal.js");
  const root = await mkdtemp(join(tmpdir(), "runtime-history-"));
  const config = { agents: [engine()], persistence: localJsonl({ root }) };
  let runtime = await createRuntime(config);
  try {
    await runtime.app.request("http://local/agents/echo/v1/ag-ui", {
      method: "POST",
      body: JSON.stringify({
        threadId: "saved",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await runtime.close();
    runtime = await createRuntime(config);
    const history = await (
      await runtime.app.request(
        "http://local/agents/echo/v1/ag-ui/sessions/saved",
      )
    ).json();
    expect(history.messages).toHaveLength(2);
    const archived = await runtime.app.request(
      "http://local/agents/echo/v1/ag-ui",
      {
        method: "POST",
        body: JSON.stringify({
          threadId: "saved",
          messages: [{ role: "user", content: "again" }],
        }),
      },
    );
    expect(archived.status).toBe(409);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects path-shaped thread IDs before running the agent", async () => {
  let runs = 0;
  const runtime = await createRuntime({
    agents: [engine(() => {}, async () => {}, undefined)].map((agent) => ({
      ...agent,
      run(options?: { id?: string }) {
        runs += 1;
        return agent.run(options);
      },
    })),
  });
  try {
    for (const threadId of ["../escape", "a/b", "..", ""]) {
      const response = await runtime.app.request(
        "http://local/agents/echo/v1/ag-ui",
        {
          method: "POST",
          body: JSON.stringify({
            threadId,
            messages: [{ role: "user", content: "hello" }],
          }),
        },
      );
      expect(response.status, threadId).toBe(threadId === "" ? 200 : 400);
    }
    expect(runs).toBe(1);
  } finally {
    await runtime.close();
  }
});

import { Agent, createClient, connectAgents } from "@nylorun/agents";
import { createRuntime } from "@nylorun/runtime";
import { piModel } from "@nylorun/runtime/node";
import type { ModelAdapter } from "@nylorun/harness";

const model: ModelAdapter = piModel();
void model;
const agent = Agent({ id: "test", name: "Test" }).build();
// @ts-expect-error Definitions do not execute themselves.
agent.run();
const client = createClient({ url: "http://127.0.0.1:8787", key: "server" });
const session = await client.createSession({
  agentId: agent.manifest.id,
  ownerUserId: "local",
});
await session.input("hello", { idempotencyKey: "input-1" });
await session.history();
await session.cancel({ idempotencyKey: "cancel-1" });
const connection = connectAgents({
  agents: [agent],
  runtime: { url: "http://127.0.0.1:8787", key: "executor" },
});
await connection.close();
void createRuntime;

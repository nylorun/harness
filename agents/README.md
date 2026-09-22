# @nylorun/agents

One application install provides definition authoring, a session client, and a connected customer executor. This beta is currently built locally; no packages were published in this pass. Use the workspace or install packed SDK and core artifacts together until publishing is enabled.

```ts
import { Agent, createClient, connectAgents, tool } from "@nylorun/agents";
import { z } from "zod";

const assistant = Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "Use the available tools.",
  tools: [
    tool({
      name: "lookup",
      input: z.object({ id: z.string() }),
      async run({ id }, ctx) {
        return { id, owner: ctx.info };
      },
    }),
  ],
});

// Run these application operations on your trusted backend.
const client = createClient({
  url: process.env.NYLORUN_RUNTIME_URL,
  key: process.env.NYLORUN_SERVER_KEY,
});
await client.saveAgent(assistant, { implementationVersion: "app-1" });
const session = await client.createSession({
  agentId: assistant.id,
  ownerUserId: authenticatedUser.id,
});
await session.input("Look up item 123", { idempotencyKey: requestId });
const history = await session.history();

// Customer executor process: credential is separately scoped by the Runtime.
const connection = connectAgents({
  agents: [assistant],
  implementationVersion: "app-1",
  runtime: {
    url: process.env.NYLORUN_RUNTIME_URL,
    key: process.env.NYLORUN_EXECUTOR_KEY,
  },
  onError: console.error,
});
await connection.ready;
// On shutdown:
await connection.close();
```

Use `session.observe({ cursor, signal })` for resumable canonical events, `session.inspect()` for waiting/uncertain state, and `approve`, `respond`, or `cancel` with an explicit stable idempotency key. Retry the same semantic command with the same key. `ownerUserId` must come from trusted server authentication. Application credentials are not browser credentials; browser applications need an authorized backend. Definition authoring is browser-bundleable.

The Runtime destination is explicit, or defaults from `NYLORUN_RUNTIME_URL`. Application and executor keys default from `NYLORUN_SERVER_KEY` and `NYLORUN_EXECUTOR_KEY`. Implementation version defaults from `NYLORUN_IMPLEMENTATION_VERSION`, then `dev`. A host must provision executor scope for the agent id. Agents do not hash the manifest, and an in-flight action stays claimable after the registered digest changes. Model selection and model credentials belong to the Runtime.

`connectAgents({ agents })` opens authenticated fetch SSE before discovering actions, rediscovers after reconnection, and claims pending actions for a connected agent id. It renews leases while executing, then retries HTTP result delivery with the same recorded outcome and idempotency key. Reconnect delay is bounded at 30 seconds. Notifications confer no execution authority. There is no periodic action-discovery polling. Close aborts the stream, HTTP requests and lease timers and signals running functions; JavaScript cannot forcibly terminate a function that ignores its signal. The host makes expired in-flight actions uncertain instead of automatically repeating external effects.

Tools receive state, info, identity, resume, signal, approval/response helpers and memoized `step`. Step outcomes survive a persisted wait result; they do not establish exactly-once external effects after an unacknowledged crash. `sleep` and `waitFor` currently return inspectable deferred outcomes; automatic timer/event wakeups remain runtime implementation work. Remote `onModelCall` convenience and progress-event transport are not supplied in this pass. Arbitrary middleware closures are rejected for durable definitions; use before/after hooks. Agent definitions have no `.run()`; explicit local execution is available through `@nylorun/harness/run`.

The SDK depends only on core within the Nylorun packages; installing it does not install harness. Use `/define`, `/client`, or `/executor` for focused imports, or the root for convenience. Studio uses `/client`. See [the adopted host contract](../harness/HOST_CONTRACT.md).

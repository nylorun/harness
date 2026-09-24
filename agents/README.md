# @nylorun/agents

One application install provides definition authoring, a session client, and a
connected customer executor. This beta is currently built locally; no packages
were published in this pass. Use the workspace or install packed SDK and core
artifacts together until publishing is enabled. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

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

// Trusted backend: name the Tenant explicitly (or via NYLORUN_TENANT).
const client = createClient({
  url: process.env.NYLORUN_RUNTIME_URL,
  key: process.env.NYLORUN_SERVER_KEY,
  tenant: process.env.NYLORUN_TENANT,
});
await client.saveAgent(assistant, { implementationVersion: "app-1" });
const session = await client.createSession({
  agentId: assistant.id,
  ownerUserId: authenticatedUser.id,
});
await session.input("Look up item 123", { idempotencyKey: requestId });
const history = await session.history();

// Customer executor: same Host URL + Tenant; executor principal is separate.
const connection = connectAgents({
  agents: [assistant],
  implementationVersion: "app-1",
  runtime: {
    url: process.env.NYLORUN_RUNTIME_URL,
    key: process.env.NYLORUN_EXECUTOR_KEY,
    tenant: process.env.NYLORUN_TENANT,
  },
  onError: console.error,
});
await connection.ready;
// On shutdown:
await connection.close();
```

Or, after linking a Project:

```sh
eval "$(npx nylorun runtime status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

Every request sets `Nylorun-Tenant` and `Nylorun-Protocol`. A `tenant` field in a
body or query is never read from caller input. Before the first authenticated
request, `Transport` fetches `/health` once, checks protocol compatibility, and
throws `IncompatibleRuntimeError` when the Host range or required features do
not match. Omit `tenant` only when `NYLORUN_TENANT` is set; otherwise the client
throws before any request: `Set tenant explicitly or via NYLORUN_TENANT`.

Load Agent Skills from a local catalog folder with `skills(path)`:

```ts
import { Agent, skills } from "@nylorun/agents";

const assistant = Agent({
  id: "assistant",
  name: "Order assistant",
  instructions: "Use lookup_order for orders.",
  tools: [lookupOrder],
}).use(skills("./assistant-skills"));
```

Each subdirectory under the catalog must contain a `SKILL.md` with YAML frontmatter (`name`, `description`) per [Agent Skills](https://agentskills.io/home). Supporting files (for example `references/`) are available through `read_skill_resource` after `load_skill`. The helper sets both the manifest skill catalog and the on-disk skill records so you do not duplicate content.

Declare MCP servers with `mcp(...)` (same map shape as agent-plugins `mcpServers` / manifest v3):

```ts
import { Agent, mcp } from "@nylorun/agents";

const assistant = Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "Use the available tools.",
}).use(
  mcp({
    github: {
      name: "github",
      type: "streamable-http",
      url: "https://mcp.example.com/github",
    },
  }),
);
```

Each key must equal that server's `name`. Transports follow [Agent Plugins MCP servers](https://agent-plugins.org/plugin-authors/mcp-servers): `stdio`, `streamable-http`, and `sse`. Pass `{ id: "…" }` as the second argument to override the default capability id `"mcp"`.

Give an agent an isolated computer with `sandbox()`:

```ts
import { Agent, sandbox } from "@nylorun/agents";

const analyst = Agent({
  id: "analyst",
  instructions: "Analyse the data the user gives you. Use Python.",
}).use(sandbox());
```

The model gets `bash`, `read`, `write`, `edit`, `grep` and `glob` on a Linux machine with a persistent `/workspace`. These tools run in the Runtime, not in your process, so sandbox-only agents need no connected executor. The agent declares what it needs; the Runtime decides where it runs (a microsandbox VM where the machine supports it, otherwise an emulated shell). Every option is optional plain data:

```ts
.use(sandbox({
  image: "python:3.13",                           // any OCI image; default python:3.13-slim
  network: { preset: "dev", allow: ["api.example.com"] }, // "none" | "dev" (default) | "open"
  resources: { cpus: 2, memory: "2GiB" },
  idle: "15m",                                    // stop compute when idle; files persist
}))
```

The `dev` preset allows package registries and code hosts. Private networks, loopback, the host and cloud metadata endpoints are always blocked. Options from the full design that are not in this version (`setup`, `files`, `secrets`, `mount`, `onStart`, …) throw a `SandboxError` that says so. See [the sandbox design](../docs/design/sandboxes.md).

Put an agent in another agent's `tools` to let the model delegate to it:

```ts
import { Agent } from "@nylorun/agents";
import { z } from "zod";

const researcher = Agent({
  id: "researcher",
  description:
    "Investigates an order's history. Returns a short summary with the ids it relied on.",
  instructions:
    "Investigate one question about one order. Be exhaustive, then be brief.",
  tools: [searchOrders, readTicket],
  outputSchema: z.object({
    summary: z.string(),
    evidence: z.array(z.string()),
  }),
});

const support = Agent({
  id: "support",
  instructions:
    "For anything needing more than two lookups, delegate to researcher with a complete, self-contained task.",
  tools: [lookupOrder, refundOrder, researcher],
});
```

The tool is named after the agent's `id` and takes `{ task: string }`; the agent's `description` (required) is what the parent's model reads to decide when to delegate. The child starts with a fresh context: it sees its own instructions and the task, nothing of the parent's conversation, and only its final text (or `outputSchema` result) comes back. It keeps its own tools, hooks, skills and MCP servers, served by the executor you already run for the parent (`connectAgents({ agents: [support] })` serves both), shares the session's sandbox, and starts with empty `ctx.state`. Tools can read `ctx.agent` (`{ id, path, delegationId }`). Several delegation calls in one model response run in parallel. An empty answer, a failure (with the child's last text marked as evidence) or a cancelled child reaches the parent's model as a failed tool result, never as success. The Runtime emits `delegation.started` and `delegation.completed`; `session.history({ agent })` filters by `delegationId` (one child invocation) or by path such as `support/researcher` (every concurrent child that shares that path).

Delegate when the parent should keep the answer. When a specialist should own the rest of the conversation, switch capabilities with a `before("step")` patch instead. This version is one level deep and non-interactive: a delegated agent cannot use agents as tools, its tools cannot declare `approval` (keep those on the parent), and `ctx.ask`, `ctx.approve`, `ctx.sleep` or `ctx.waitFor` inside it fail with `delegation.interaction-unsupported`. Delegation is not an approval boundary; approvals live on tools.

Use `session.observe({ cursor, signal })` for resumable canonical events, `session.inspect()` for waiting/uncertain state, and `approve`, `respond`, or `cancel` with an explicit stable idempotency key. Retry the same semantic command with the same key. `ownerUserId` must come from trusted server authentication. Application credentials are not browser credentials; browser applications need an authorized backend. Definition authoring is browser-bundleable.

The Runtime Host destination is explicit, or defaults from `NYLORUN_RUNTIME_URL`.
Application and executor keys default from `NYLORUN_SERVER_KEY` and
`NYLORUN_EXECUTOR_KEY`. Tenant id defaults from `NYLORUN_TENANT` when omitted.
Implementation version defaults from `NYLORUN_IMPLEMENTATION_VERSION`, then
`dev`. The Tenant must provision an executor principal for the agent id. Agents
do not hash the manifest, and an in-flight action stays claimable after the
registered digest changes. Model selection and model credentials belong to the
Tenant.

`connectAgents({ agents })` opens authenticated fetch SSE before discovering actions, rediscovers after reconnection, and claims pending actions for a connected agent id. It renews leases while executing, then retries HTTP result delivery with the same recorded outcome and idempotency key. Reconnect delay is bounded at 30 seconds. Notifications confer no execution authority. There is no periodic action-discovery polling. Close aborts the stream, HTTP requests and lease timers and signals running functions; JavaScript cannot forcibly terminate a function that ignores its signal. The host makes expired in-flight actions uncertain instead of automatically repeating external effects.

Tools receive state, info, identity, resume, signal, approval/response helpers and memoized `step`. Step outcomes survive a persisted wait result; they do not establish exactly-once external effects after an unacknowledged crash. `sleep` and `waitFor` currently return inspectable deferred outcomes; automatic timer/event wakeups remain runtime implementation work. Remote `onModelCall` convenience and progress-event transport are not supplied in this pass. Arbitrary middleware closures are rejected for durable definitions; use `before`/`after` hooks. The executor runs every capability registered at a hook point in one action. Agent definitions have no `.run()`; explicit local execution is available through `@nylorun/harness/run`.

The SDK depends only on core within the Nylorun packages; installing it does not install harness. Use `/define`, `/client`, or `/executor` for focused imports, or the root for convenience. Studio uses `/client`. See [the adopted host contract](../harness/HOST_CONTRACT.md).

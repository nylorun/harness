# `@nylorun/harness`

Shared definitions, session/action contracts, execution engine, and compatibility metadata. Author applications through `@nylorun/agents`; hosts consume this package directly. The OSS and Cloud runtimes are independent and share the same engine.

Use `/define` for execution-free authoring, `/contracts` for wire schemas, `/engine` for explicit execution and the durable host interface, and `/compatibility` for compatibility/version metadata. See [HOST_CONTRACT.md](HOST_CONTRACT.md). Cloud consumes a locally packed artifact directly; it does not depend on the OSS Runtime.

> **DX v5.6:** definition ⊥ engine. `model` is not on `Agent({})` — Runtime injects `onModelCall`. Host data stays `info` (not `user`); session memory is `state`.

## Compose an agent

```ts
import { Agent, tool, ToolError, capability } from "@nylorun/harness/define";
import { z } from "zod";

const lookup = tool({
  name: "lookup_order",
  input: z.object({ orderId: z.string() }),
  effects: "read",
  async run({ orderId }, ctx) {
    const order = await orders.find(orderId, { info: ctx.info, signal: ctx.signal });
    if (!order) throw new ToolError("not_found", "No such order.");
    return order; // plain return = completed
  },
});

export const supportAgent = Agent({
  id: "support",
  name: "Support",
  instructions: "You help customers with orders. Be brief.",
  tools: [lookup],
})
  .use(capability({ id: "policy", afterModelCall: ({ text }) => ({}) }))
  .beforeModelCall(({ info, state }) => ({ instructions: [`Tenant ${info?.tenantId}`] }));

// Optional: .build() is a no-op facade
const agent = supportAgent.build();

JSON.stringify(supportAgent); // manifest
Agent.from(supportAgent.toJSON(), implementations);
```

`.use()` returns a **new** agent. Top-level `tools` / `instructions` are first-class. Do **not** put `model` on `Agent({})` — Runtime resolves and calls the model.

## Run the loop

Taught path for hosts/Runtime:

```ts
import { run, bindingFromAgent } from "@nylorun/harness/engine";

const result = await run({
  binding: bindingFromAgent(supportAgent.build()),
  input: "Hello",
  onModelCall: async () => "Hello back!",
  info: { tenantId: "acme" },
  record: (state) => store.save(state),
});
```

This is a breaking beta: `agent.run()` has been removed. Application execution uses SDK sessions. Hosted execution uses `createHostedCheckpoint` and `runHosted` with individually persisted model/tool/hook effects; a suspended checkpoint requires its effect journal.

## Tools

Prefer `input` / `output` / `run`. Legacy `inputSchema` / `execute` and tagged `{ kind: "completed" }` outcomes still work.

- `approval` — declarative pause before execute (code-only; not in the manifest)
- `effects` — `"read" | "idempotent" | "write"` (code-only)
- `ctx.idempotencyKey`, `ctx.redelivery`, `ctx.state`, `ctx.session`, `ctx.progress`
- Durable waits: `ctx.ask`, `ctx.approve`, `ctx.sleep`, `ctx.waitFor`, `ctx.step`

Definitions must not import `@nylorun/runtime`.

## Dynamics

`beforeModelCall` → `Patch` (capabilities/tools/instructions/state/block — no `model`).
`afterModelCall` → `Decision` (text/deny/approve/retry/block).
Local explicit engine execution retains middleware. Hosted manifests reject arbitrary middleware closures; use before/after hooks.

## Checkpoint / durability

`ExecutionState` is the continuation token (plus `manifestHash`). Runtime persists `record(state)` at durable boundaries and resumes with `continue` / `approve` / `respond` / `settle`. `checkCompatibility(manifest, state)` fails on hash mismatch.

## Client types

The authoritative session/action wire schemas live in `/contracts` and do not import engine checkpoint types. Use `@nylorun/agents` for the session client and SSE executor. Historical root client types remain for deferred local tooling; they are not the new wire contract.

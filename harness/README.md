# `@nylorun/harness`

Observable, portable, composable **agent definition** package. Compose agents as JSON plus your functions; run the loop via `@nylorun/harness/engine` (or the 1.0 `agent.run()` alias). An application or optional Runtime owns sessions, model resolution, and durability.

> **DX v5.6:** definition ⊥ engine. `model` is not on `Agent({})` — Runtime injects `onModelCall`. Host data stays `info` (not `user`); session memory is `state`.

## Compose an agent

```ts
import { Agent, tool, ToolError, capability } from "@nylorun/harness";
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
  binding: bindingFromAgent(supportAgent),
  input: "Hello",
  onModelCall: async () => "Hello back!",
  info: { tenantId: "acme" },
  record: (state) => store.save(state),
});
```

Through 1.0, `agent.run({...})` remains an alias for the same engine.

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
Middleware remains through 1.0; map before `next()` → beforeModelCall, after → afterModelCall.

## Checkpoint / durability

`ExecutionState` is the continuation token (plus `manifestHash`). Runtime persists `record(state)` at durable boundaries and resumes with `continue` / `approve` / `respond` / `settle`. `checkCompatibility(manifest, state)` fails on hash mismatch.

## Client types

Type-only `Session` / `Turn` / `Event` / `Result` are exported for Runtime clients — harness does not implement sessions.

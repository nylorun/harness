# `@nylorun/harness`

Observable, portable, composable agent execution. Harness runs a model/tool loop with invocation-local progress; an application or optional Runtime owns sessions.

> **Breaking beta:** this interface replaces the Session-returning `run()` API. See [migration](../MIGRATION.md).

## Run an agent

```ts
import { Agent } from "@nylorun/harness";

const agent = Agent({ id: "assistant", name: "Assistant" }).build();
const result = await agent.run({
  input: "Hello",
  onModelCall: async (call) => "Hello back!", // Your model adapter
});
if (result.status === "completed") console.log(result.output);

const next = await agent.run({
  state: result.state,
  input: "Continue our conversation",
  onModelCall,
});
```

Every call returns a Promise. Omitted state starts an empty execution. The built agent retains definitions, not progress; supplied state is never mutated. Multiple calls may use the same agent concurrently. Applications must coordinate concurrent updates to the same conversation.

Outcomes are `completed` (with `output`), `paused` (with `pending`), `cancelled`, or `failed` (with `error`). Each includes serializable `state`. Invalid options, incompatible state, and invalid continuation inputs reject before model/tool execution. Operational failures return `failed`. Recording failures reject.

## Optional controls

```ts
const result = await agent.run({
  state,
  input,
  onModelCall,
  scope: { userId, tenantId },
  signal: controller.signal,
  onEvent: (event) => console.log(event),
  record: (state) => sessionStore.save(sessionId, state),
});
```

`scope` is fresh, trusted application data available as `request.scope` in middleware and `context.scope` in tools. Type it with `Agent<MyScope>(...)`. Harness does not put scope into state, observations, or model requests. Middleware can deliberately add model-visible data through its existing `request.context` interface. The application owns authentication and authorization, including checking access to the original resource after continuation.

`signal` is cooperative: Harness checks before further work, forwards it to adapters and tools, and waits for dispatched work to settle. Cancellation preserves settled results, cannot undo external effects, and cannot forcibly stop an uncooperative dependency. Harness has no cancellation or shutdown method. The developer owns clients, connections, subprocesses, and their cleanup.

To cancel a saved pause, call `run({ state, input: { kind: "continue" }, signal: AbortSignal.abort(), onModelCall })`. This settles the pending plan without dispatching it. `state.cancelledCalls` retains unresolved invocation references and deferred tokens for reconciliation, outside the model transcript; cancelling a deferred job does not stop external work by itself. Runtime's `host.cancel(agent, sessionId)` applies this transition and persists it before accepting replacement work.

`onEvent` reports ordered events with execution, run, turn, step, model invocation, and tool call identifiers where applicable. Observer exceptions produce `observation.failed` diagnostics without changing results. Observations describe execution; they do not acknowledge durable commits. Explicit model-visible content and tool output can appear in events, so applications still control sensitive data they put there.

`record` receives independent immutable JSON snapshots, serially. Harness awaits each recording barrier: accepted plans after middleware unwinds and before dispatch, active work markers, settled tool batches, pauses, and final outcomes. A rejected recording stops further dispatch; active work has settled before rejection. An external operation may succeed before a write fails. An intermediate active snapshot requires reconciliation and never authorizes automatic replay.

## Final output contracts

```ts
import { z } from "zod";
const agent = Agent({
  id: "extractor",
  name: "Extractor",
  outputSchema: z.object({ answer: z.string() }),
}).build();
// A completed result.output is inferred as { answer: string }.
```

The schema belongs to the agent definition, is supplied to adapters, and validates the accepted final response after middleware. Adapters return a JSON output block for structured results. There is no per-run or per-turn schema override. Tool output schemas remain tool-specific. With an explicitly typed scope and output schema, use `Agent<MyScope, typeof schema>({...})`.

## Register and expose tools

```ts
const lookup = {
  name: "lookup",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }, { scope, signal }) => ({
    kind: "completed" as const,
    output: await database.lookup(id, { scope, signal }),
  }),
};
const agent = Agent({ id: "assistant", name: "Assistant" })
  .use({ id: "database", tools: [lookup] })
  .build();
```

`.use()` registers code. Middleware selects registered tools through `request.configuration.tools.set(slot, tools)`. Changing the subset needs no restoration callback. Unregistered executable closures are rejected before a model call. Middleware wrapping order is preserved; tool plans are accepted only after the stack unwinds.

For tools whose identity or contracts depend on discovered data, register a family:

```ts
import { defineToolFamily } from "@nylorun/harness";
const queryTable = defineToolFamily({
  id: "query-table",
  version: "1",
  bindingSchema: z.object({ table: z.string() }),
  describe: (binding) => ({
    name: `query_${binding.table}`,
    inputSchema: z.object({ query: z.string() }),
  }),
  execute: async (args, { binding, scope, signal }) => ({
    kind: "completed",
    output: await warehouse.query({
      table: binding.table,
      query: args.query,
      principal: scope,
      signal,
    }),
  }),
});
const capability = {
  id: "warehouse",
  toolFamilies: [queryTable],
  middleware: async (request, next) => {
    request.configuration.tools.set("tables", [queryTable.bind({ table: "orders" })]);
    return next();
  },
};
```

Bindings are validated, copied JSON. `describe()` must be synchronous and deterministic from binding data and deployed code. Include discovered contracts in the binding if needed to reconstruct the descriptor. Never bind credentials or live clients. Family definitions and ordinary executable definitions are retained independently of each invocation's selections.

## Pause and continue

An approval or response request, or a tool returning `{ kind: "deferred", token }`, settles the invocation as `paused`. Persist the returned state intact. Rebuild the same agent definition and call `run()` again:

```ts
await agent.run({
  state: savedState,
  input: { kind: "approve", interactionId, approved: true },
  scope: freshTrustedScope,
  onModelCall,
});
// A response uses { kind: "respond", interactionId, value }.
// A deferred settlement uses { kind: "settle", invocationId, outcome:
//   { kind: "completed", output: jobResult } }.
```

Ordinary tools restore automatically. Families restore using saved bindings, not fresh discovery. Accepted descriptors, arguments, ordering, decisions, and invocation IDs survive; settled tools and middleware are not rerun for restoration. An execute-time interaction may re-enter that tool with `context.resume`; use its saved token to continue, not repeat prior effects.

`createExecutionState(agent)` and `validateExecutionState(value)` help initialize and validate state. Applications should not hand-author pending plans. State is a trusted continuation record, not an authorization credential; never accept client-controlled state without validation and access control.

Missing definitions, changed contracts or bindings, and duplicate/mismatched continuation inputs reject. `executionVersion` defaults to `"1"`; bump it for incompatible changes to agent behavior, validators, or policy. Family versions must likewise change for incompatible implementations. Schema comparisons cannot detect arbitrary behavior changes inside JavaScript functions.

Completed turns and explicit pauses can continue in a new process. Automatic crash replay and deferred model continuation are not supported. One-shot child work is `await child.run(...)`; separately addressable child sessions belong to a host.

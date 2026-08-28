# @nylorun/harness

`@nylorun/harness` is a small, provider-neutral agent loop. It seals one model adapter, an optional default model directive, tool adapters, and an ordered middleware onion into a fixed Agent, then runs independent in-memory Sessions. Middleware stages named changes against a session-scoped prompt-prefix state; each Model call receives an immutable canonical prefix, then its candidate is reviewed and its tool plan sealed before any adapter runs.

> **Experimental beta.** Install the current candidate with `npm install @nylorun/harness@beta`. Until 1.0, this API is intentionally experimental: minor releases may contain breaking changes, while patch releases are reserved for compatible fixes. See [CHANGELOG.md](./CHANGELOG.md) for migration notes.

```ts
import { Agent, adapter, model, tool } from "@nylorun/harness";
import { z } from "zod";

const local = adapter({
  id: "local",
  async execute(call) {
    return { kind: "completed" as const, output: { echoed: call.args } };
  },
});

const echo = tool({
  name: "echo",
  description: "Echo a message",
  parameters: z.object({ text: z.string() }),
  executeWith: "local",
});

const example = model(async (call, { request }) => {
  return request.toolResults.length === 0
    ? {
        output: [{ type: "tool-call", id: "call_1", name: "echo", args: { text: "hello" } }],
      }
    : `Completed with ${JSON.stringify(request.toolResults[0]?.output)}`;
});

const session = Agent(example, { id: "example" })
  .with(local)
  .use("echo", async (request, next) => {
    request.configuration.tools.set("echo-tools", [echo], { order: 100 });
    request.configuration.instructions.set("echo-policy", ["Echo the user text."], { order: 100 });
    return next();
  })
  .use("turn-budget", async (request, next) => {
    if (request.turnNumber > 8) {
      return request.tripwire({ code: "turn.limit", message: "Limit reached" });
    }
    return next();
  })
  .build()
  .run();
session.observe((event) => {
  if (event.type === "model.requested") console.log("model", event.attributes);
});
session.input("Echo hello");
for await (const event of session.stream()) {
  if (event.type === "final") {
    console.log(event.output);
    await session.stop();
  }
}
```

`Agent(model, directive?)` returns a builder. The first argument is the model callback `(call, { request, signal })`; the optional directive (`{ id?, controls?, config? }`) is seeded into every model step and can be replaced or cleared for that call. `.with(adapter, { maxConcurrentCalls? })` registers an adapter by `adapter.id` (required for tool dispatch via `executeWith`); omitted `maxConcurrentCalls` dispatches sibling `execute()` calls in parallel without a Harness cap, while a positive safe integer is a FIFO limit shared by all Sessions from that `BuiltAgent`. Adapter authors remain responsible for concurrent safety when no limit is supplied. Call order has no onion effect. `.use(middleware)` or `.use(id, middleware)` appends middleware (later is more inward); omitted ids become `middleware-1`, `middleware-2`, …. `.build()` validates ids and seals a `BuiltAgent`, or throws `AgentBuildError`. `BuiltAgent.run(options?)` creates an in-memory Session. `session.input("hello")` or `session.input({ text, metadata? })` queues a user message and returns a completion handle; while a turn is running or waiting, that message stays queued until the current turn finals, then a new turn starts. Approve and respond stay on `session.input({ kind: "approve" | "respond", ... })` — those are interaction replies, not messages. `session.interrupt("...")` queues barge-in text: if the current turn still has another step, the interrupt is claimed as that step’s arrivals (same turn, no abort of the in-flight model or tool work); if the turn already finalized, it starts a new turn like ordinary input. `session.stream()` yields the conversation (`input`, per-step `candidate`, then settlement events) — not observe events or tool results. `session.observe(listener)` adds a live, fail-open observer and returns an idempotent unsubscribe function; it does not replay earlier events. `session.stop()` ends that Session only.

## Middleware

Middleware is the Model lifecycle:

```ts
type StepMiddleware = (
  request: StepRequest,
  next: () => Promise<StepResponse>,
) => Promise<StepResponse>;
```

Each `StepRequest` includes opaque `sessionId`, `turnId`, and `stepId` identities, so middleware can associate application-owned state with the current execution. Draft the current call on `request.configuration`: named `instructions.set`, `tools.set`, and `model.select` / `replace` / `clear`; draft current-call tail data on `request.context.set`; or tripwire. `await next()` runs the inner onion and one Model call, then returns a branded `StepResponse`. Review that candidate (`deny`, `requireInteraction`, `requirePreflight`, `replace`, `tripwire`) and return it. Skipping `next()` is legal only by returning `request.tripwire(...)`. `void next()` is not supported.

Configuration and context are fresh assemblies for each model call. A repeated `set` for the same middleware/slot replaces that middleware’s earlier declaration in that step; nothing is retained for the next step. A middleware can declare only its own slot. Cross-cutting policy belongs in the tool-owning middleware or the host's final assembly decision; `deny()` remains available to reject a specific requested call after inspecting its arguments. Effective instruction and visible-tool order is canonical: explicit `order`, middleware registration order, slot name, then declaration order. A model directive is `{ id?, controls?, config? }`; `select` is idempotent, `replace` is the explicit override, and `clear` suppresses the Agent directive only for the current call. Duplicate tool names and invalid schemas tripwire before the Model runs. `reason` is attribution emitted to observers; Harness does not enforce drift policy.

Context is separate from the configuration digest. `context.set(slot, items, { order?, reason? })` contributes only to the current call. `run({ context })` is freshly projected as a host-attributed `type: "session"` item on every call. Applications that need state across calls own it and explicitly re-declare the model-visible portion using the request identities.

`ModelAdapter` receives a projected `ModelCall` first (`prompt`, `tools`, optional `model`, `sessionId`), then `{ request, signal }`: the structured `ModelRequest` escape hatch and its cancellation signal. `prompt` is an ordered typed list: `instructions` (system), then transcript `message` / `tool-result` items, then one `context` item when the committed snapshot is non-empty. Context is a user-role envelope around a JSON array of `{ type?, value }` — structural serialization so a value cannot mint a sibling prompt item, not a sandbox against prompt injection. Tool-result items keep `toolName` and `status`. Arrivals and toolResults stay on `request` — they are already on the transcript before invoke, so appending them would duplicate history. `turnId` and `stepId` stay on `ModelRequest` and observe events, not on `ModelCall`.

`ModelRequest.configuration` carries the selected model directive, ordered instruction text, visible provider tool contracts, contributor provenance, and logical/model/combined digests. `ModelRequest.context` is the current-step snapshot (items, contributors, digest). Immediately before invoking the adapter, Harness emits one `model.requested` event. Its `attributes.call` is the exact deeply immutable `ModelCall` supplied to the adapter; `attributes.configuration` and `attributes.context` are JSON-safe attributed snapshots. This is the immutable logical adapter-input boundary, not a provider-wire trace. Harness does not retain a baseline or audit drift; an observer such as Studio can compare these events and apply its own policy.

A successful Model return is a `ModelCandidate`: an ordered `output` of `text`, `reasoning`, and `tool-call` blocks, plus optional `finishReason`, `usage`, and `evidence`. A string return becomes one text block. Session `final` joins text blocks with `""`; reasoning is stored on the transcript candidate for observability and is never part of that string or of the tool plan. Harness projects its transcript into the portable `ModelCall` and omits reasoning when replaying assistant content. Tool-call `args` are a JSON object; `{}` is valid and is not a stand-in for parse failure. `finishReason` is `stop`, `length`, `tool-calls`, `content-filter`, or `other` — never `error` or `aborted`. Thrown `invoke` or an aborted signal stays on the `model.failed` / abort path. `evidence.extras` is for small safe fields, not raw request or response bodies. Token counts that are present must be non-negative integers; `costUsd` is optional and only when the provider supplied it.

The harness canonicalizes tool-call ids when it mints the response; `sealStep` reuses those ids. `replace` may drop calls and rewrite text or reasoning but cannot change a retained call’s name or arguments or undo an inner denial. A replace that omits `finishReason`, `usage`, or `evidence` keeps the current values.

A tripwire, invalid return, or bind failure on one Session does not stop sibling Sessions. Harness contract breaks are session-scoped. Late `setTimeout` mutations throw and emit observe events; they do not stop a settled Session.

The harness has no automatic turn, Step, or wall-clock timeout. Applications own budgets through middleware.

## Structured errors and beta migration

Harness-created errors are `HarnessError` instances. Their `code` is stable and machine-readable; their `message` is explanatory and is not a compatibility contract. `details` contains only safe identifiers and paths, and `cause` preserves a foreign underlying error when there is one. Middleware-, model-, and adapter-originated errors remain foreign causes; application-owned tripwire and tool-result codes remain unrestricted strings.

Version 0.5.0-beta.1 replaces the following built-in outcome codes without aliases:

| Previous code / condition                                                                      | 0.5 code                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool.duplicate-name`                                                                          | `configuration.duplicate-tool-name`                                                                                                                                 |
| `model.selection-conflict`                                                                     | `configuration.model-selection-conflict`                                                                                                                            |
| `tool.invalid`                                                                                 | `tool.invalid-name`, `tool.invalid-schema`, or `adapter.not-registered`                                                                                             |
| `prefix.invalid`                                                                               | `configuration.invalid-instructions`, `configuration.invalid-tools`, `configuration.invalid-slot`, `configuration.invalid-reason`, or `configuration.invalid-order` |
| prefix status / drift policy                                                                   | Removed; compare `model.requested` events in the observing application.                                                                                             |
| `response.replace-invalid`                                                                     | `response.invalid-replacement`                                                                                                                                      |
| `model.failed` for invalid Harness-normalized candidates                                       | `model.invalid-candidate`                                                                                                                                           |
| `middleware.failed` for Harness middleware-protocol faults                                     | `middleware.request-mutators-revoked`, `middleware.next-after-return`, or `middleware.next-called-twice`                                                            |
| `tool.execution-failed` / `tool.preflight-failed` for malformed Harness-validated adapter data | `adapter.invalid-outcome`, `tool.invalid-tool-result`, or `interaction.invalid`                                                                                     |
| `harness.invalid-directive` build diagnostic                                                   | `model.invalid-directive`                                                                                                                                           |

Foreign model invocation failures still report `model.failed`; this distinguishes them from Harness validation failures.

## Zod-only tool schemas

Harness `0.5.0-beta.1` accepts synchronous `z.object(...)` schemas only. Import `z` from `zod`; Harness does not re-export it. `tool()` validates and converts the schema to immutable JSON Schema when the definition is created; raw object literals are prepared on their first declaration.

## Manifest

`agent.manifest` is a frozen description of the sealed onion, the optional default model directive, and adapters (`id` plus an optional `maxConcurrentCalls`). It has no session configuration state. Observe `model.requested` for the per-call, JSON-safe attributed assembly; executable tool validators are omitted.

The package intentionally does not own persistence, restart recovery, credentials, transports, provider-specific wire conversion, background jobs, or detached Tool work.

## Internals

The in-memory loop is **build → session → turn → step**. Start with [docs/loop.md](./docs/loop.md). The complete [error-code and observe-event reference](./docs/reference.md) documents the stable machine-readable surfaces.

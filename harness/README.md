# @nylorun/harness

`@nylorun/harness` is a small, provider-neutral agent loop. It seals one model adapter, an optional default model directive, tool adapters, and an ordered middleware onion into a fixed Agent, then runs independent in-memory Sessions. Middleware stages named changes against a session-scoped prompt-prefix state; each Model call receives an immutable canonical prefix, then its candidate is reviewed and its tool plan sealed before any adapter runs.

```ts
import { Agent, adapter, model, tool } from "@nylorun/harness";
import { z } from "zod";

const local = adapter({
  id: "local",
  validateRoute() {},
  async execute(call) {
    return { kind: "completed" as const, output: { echoed: call.args } };
  },
});

const echo = tool({
  name: "echo",
  description: "Echo a message",
  input: z.object({ text: z.string() }),
  executeWith: "local",
  route: { operation: "echo" },
});

const example = model(async (request) => {
  return request.toolResults.length === 0
    ? {
        output: [{ type: "tool-call", id: "call_1", name: "echo", args: { text: "hello" } }],
      }
    : `Completed with ${JSON.stringify(request.toolResults[0]?.output)}`;
});

const session = Agent(example, { id: "example" })
  .with(local)
  .use("echo", async (request, next) => {
    request.prefix.tools.set("echo-tools", [echo], { order: 100 });
    request.prefix.instructions.set("echo-policy", ["Echo the user text."], { order: 100 });
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
  if (event.type === "model.started") console.log("model", event.attributes);
});
session.input("Echo hello");
for await (const event of session.stream()) {
  if (event.type === "final") {
    console.log(event.output);
    await session.stop();
  }
}
```

`Agent(model, directive?)` returns a builder. The first argument is the model callback; the optional directive (`{ id?, controls?, config? }`) seeds every Session prefix. `.with(adapter)` registers an adapter by `adapter.id` (required for tool dispatch via `executeWith`); call order has no onion effect. `.use(middleware)` or `.use(id, middleware)` appends middleware (later is more inward); omitted ids become `middleware-1`, `middleware-2`, …. `.build()` validates ids and seals a `BuiltAgent`, or throws `AgentBuildError`. `BuiltAgent.run(options?)` creates an in-memory Session. `session.input("hello")` or `session.input({ text, metadata? })` queues a user message and returns a completion handle; while a turn is running or waiting, that message stays queued until the current turn finals, then a new turn starts. Approve and respond stay on `session.input({ kind: "approve" | "respond", ... })` — those are interaction replies, not messages. `session.interrupt("...")` queues barge-in text: if the current turn still has another step, the interrupt is claimed as that step’s arrivals (same turn, no abort of the in-flight model or tool work); if the turn already finalized, it starts a new turn like ordinary input. `session.stream()` yields the conversation (`input`, per-step `candidate`, then settlement events) — not observe events or tool results. `session.observe(listener)` receives fail-open observe events. `session.stop()` ends that Session only.

## Middleware

Middleware is the Model lifecycle:

```ts
type StepMiddleware = (
  request: StepRequest,
  next: () => Promise<StepResponse>,
) => Promise<StepResponse>;
```

Draft on `request.prefix`: named `instructions.set` / `remove`, `tools.set` / `remove` / `withhold` / `restore`, and `model.select` / `replace` / `clear`; add dynamic tail data through `request.context`; or tripwire. `await next()` runs the inner onion and one Model call, then returns a branded `StepResponse`. Review that candidate (`deny`, `requireInteraction`, `requirePreflight`, `replace`, `tripwire`) and return it. Skipping `next()` is legal only by returning `request.tripwire(...)`. `void next()` is not supported.

Each named slot is owned by its middleware and persists until explicitly removed. Effective instruction and visible-tool order is canonical: explicit `order`, middleware registration order, slot name, then declaration order. A model directive is `{ id?, controls?, config? }`; `select` is idempotent and `replace` is the explicit override. Duplicate tool names and invalid schemas tripwire before the Model runs. In `run({ prefixPolicy: "strict" })`, an effective non-initial prefix change requires a mutation `reason`.

`ModelRequest.prefix` carries the selected model directive, ordered instruction text, visible provider tool contracts, contributor provenance, and logical/model/combined digests. Harness emits `model.prefix` before every `model.started` event with `initial`, `unchanged`, or `declared-change` status. These fingerprints describe the Harness logical prefix; they do not claim provider-wire equivalence, provider cache support, or a cache hit.

A successful Model return is a `ModelCandidate`: an ordered `output` of `text`, `reasoning`, and `tool-call` blocks, plus optional `finishReason`, `usage`, and `evidence`. A string return becomes one text block. Session `final` joins text blocks with `""`; reasoning is stored on the transcript candidate for observability and is never part of that string or of the tool plan. Portable-history projection (a model-callback concern) must not replay reasoning as assistant content. Tool-call `args` are a JSON object; `{}` is valid and is not a stand-in for parse failure. `finishReason` is `stop`, `length`, `tool-calls`, `content-filter`, or `other` — never `error` or `aborted`. Thrown `invoke` or an aborted signal stays on the `model.failed` / abort path. `evidence.extras` is for small safe fields, not raw request or response bodies. Token counts that are present must be non-negative integers; `costUsd` is optional and only when the provider supplied it.

The harness canonicalizes tool-call ids when it mints the response; `sealStep` reuses those ids. `replace` may drop calls and rewrite text or reasoning but cannot change a retained call’s name or arguments or undo an inner denial. A replace that omits `finishReason`, `usage`, or `evidence` keeps the current values.

A tripwire, invalid return, or bind failure on one Session does not stop sibling Sessions. Harness contract breaks are session-scoped. Late `setTimeout` mutations throw and emit observe events; they do not stop a settled Session.

The harness has no automatic turn, Step, or wall-clock timeout. Applications own budgets through middleware.

## Zod-only tool schemas

Harness `0.4.0-rc.1` accepts synchronous `z.object(...)` schemas only. Import `z` from `zod`; Harness does not re-export it. Object schemas are parsed before a Tool runs and converted to JSON Schema when the tool is added to the Step.

## Manifest

`agent.manifest` is a frozen description of the sealed onion, the optional default model directive, and adapters (`id` only). It does not list session prefix state. Observe `model.prefix` for the per-call prefix ledger and `model.started` for the exact immutable prefix delivered to the model boundary.

The package intentionally does not own persistence, restart recovery, credentials, transports, provider conversion, background jobs, or detached Tool work.

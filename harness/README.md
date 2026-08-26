# @nylorun/harness

`@nylorun/harness` is a small, provider-neutral agent kernel. It seals one model invoker, adapters, and an ordered middleware onion into a fixed Agent, then runs independent in-memory Sessions. Each Step drafts instructions, context, tools, and an optional model directive, calls that invoker once, reviews the candidate, and seals a tool plan before any adapter runs.

```ts
import { Agent, defineAdapter, defineModel, defineTool } from "@nylorun/harness";
import { z } from "zod";

const local = defineAdapter({
  id: "local",
  validateRoute() {},
  async execute(call) {
    return { kind: "completed" as const, output: { echoed: call.args } };
  },
});

const echo = defineTool({
  name: "echo",
  description: "Echo a message",
  input: z.object({ text: z.string() }),
  executeWith: "local",
  route: { operation: "echo" },
});

const model = defineModel({
  id: "example",
  async invoke(request) {
    return request.toolResults.length === 0
      ? {
          output: [{ type: "tool-call", id: "call_1", name: "echo", args: { text: "hello" } }],
        }
      : `Completed with ${JSON.stringify(request.toolResults[0]?.output)}`;
  },
});

const session = Agent(model)
  .with(local)
  .use("echo", async (request, next) => {
    request.tools.add(echo);
    request.instructions.add("Echo the user text.");
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

`Agent(model)` returns a builder. `.with(adapter)` registers an adapter by `adapter.id` (required for tool dispatch via `executeWith`); call order has no onion effect. `.use(middleware)` or `.use(id, middleware)` appends middleware (later is more inward); omitted ids become `middleware-1`, `middleware-2`, …. Hosts may `.prepend(middleware)` or `.prepend(id, middleware)` so a folder or runtime module sits outermost. `.build()` validates ids and seals a `BuiltAgent`, or throws `AgentBuildError`. `BuiltAgent.run(options?)` creates an in-memory Session. `session.input()` submits work and returns a completion handle. `session.stream()` yields conversation events. `session.observe(listener)` receives fail-open kernel telemetry. `session.stop()` ends that Session only.

## Middleware

Middleware is the Model lifecycle:

```ts
type StepMiddleware = (
  request: StepRequest,
  next: () => Promise<StepResponse>,
) => Promise<StepResponse>;
```

Draft on `request` (add instructions, context, and tools; hide tools; `request.model.select` a directive; tripwire). `await next()` runs the inner onion and one Model call, then returns a branded `StepResponse`. Review that candidate (`deny`, `requireInteraction`, `requirePreflight`, `replace`, `tripwire`) and return it. Skipping `next()` is legal only by returning `request.tripwire(...)`. `void next()` is not supported.

Tools and instructions accumulate for that Step only. The next Step starts empty. A model directive is `{ id?, controls?, config? }`: `controls` holds portable `temperature` and `maxOutputTokens`; `config` remains the opaque provider namespace. A second different `select` tripwires; `select({})` reserves the invoker’s own default and blocks a later non-default selection. An omitted `select` leaves `ModelRequest.model` unset — the harness does not supply a fallback; the invoker may use its constructor default or reject. Duplicate tool names and invalid schemas tripwire before the Model runs.

A successful Model return is a `ModelCandidate`: an ordered `output` of `text`, `reasoning`, and `tool-call` blocks, plus optional `finishReason`, `usage`, and `evidence`. A string return becomes one text block. Session `final` joins text blocks with `""`; reasoning is stored on the transcript candidate for observability and is never part of that string or of the tool plan. Portable-history projection (an invoker concern) must not replay reasoning as assistant content. Tool-call `args` are a JSON object; `{}` is valid and is not a stand-in for parse failure. `finishReason` is `stop`, `length`, `tool-calls`, `content-filter`, or `other` — never `error` or `aborted`. Thrown `invoke` or an aborted signal stays on the `model.failed` / abort path. `evidence.extras` is for small safe fields, not raw request or response bodies. Token counts that are present must be non-negative integers; `costUsd` is optional and only when the provider supplied it.

The kernel canonicalizes tool-call ids when it mints the response; `sealStep` reuses those ids. `replace` may drop calls and rewrite text or reasoning but cannot change a retained call’s name or arguments or undo an inner denial. A replace that omits `finishReason`, `usage`, or `evidence` keeps the current values.

A tripwire, invalid return, or bind failure on one Session does not stop sibling Sessions. Kernel contract breaks are session-scoped. Late `setTimeout` mutations throw and emit observe events; they do not stop a settled Session.

The harness has no automatic turn, Step, or wall-clock timeout. Applications own budgets through middleware.

## Zod-only tool schemas

Harness `0.4.0-rc.1` accepts synchronous `z.object(...)` schemas only. Import `z` from `zod`; Harness does not re-export it. Object schemas are parsed before a Tool runs and converted to JSON Schema when the tool is added to the Step.

## Manifest

`agent.manifest` is a frozen description of the sealed onion, the one bound model invoker, and adapters (`id` / optional `version` only). It does not list tools, instructions, routable model ids, or digests; those concerns stay per-Step or with the host. Observe `step.catalog` for the offered tool names and digest of that Step. Observe `model.started` / `model.completed` for optional `requestedModelId` when middleware selected an id.

The package intentionally does not own persistence, restart recovery, credentials, transports, provider conversion, background jobs, or detached Tool work.

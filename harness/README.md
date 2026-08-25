# @nylorun/harness

`@nylorun/harness` is a small, provider-neutral agent kernel. It builds ordered capability contributions into a fixed agent, then runs independent in-memory Sessions with one Model call per Step and schema-validated, sealed Tool dispatch.

```ts
import { Agent, defineAdapter, defineCapability, defineModel, defineTool } from "@nylorun/harness";
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
      ? { toolCalls: [{ id: "call_1", name: "echo", args: { text: "hello" } }] }
      : `Completed with ${JSON.stringify(request.toolResults[0]?.output)}`;
  },
});

const session = Agent.create({ model, adapters: { local } })
  .with(defineCapability({ id: "echo", setup: () => ({ tools: [echo] }) }))
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

`Agent.create(options)` returns a builder. `.with(capability)` adds one capability. `.build()` validates, merges, and seals an `Agent`, or throws `AgentBuildError`. `Agent.run(options?)` creates an in-memory Session and returns it immediately. `session.input()` submits work and returns a completion handle (`inputId`, `completed`, `consume`) that is not an async iterable. `session.stream()` yields conversation `SessionEvent`s for the Session’s life. `session.observe(listener)` receives fail-open kernel telemetry for that Session. `session.stop()` ends the Session. History hydration is not implemented; the runtime keeps a live Session and owns durable records.

## Zod-only tool schemas

Harness `0.4.0-rc.1` accepts synchronous `z.object(...)` schemas only. Replace legacy
`{ jsonSchema, validate }` or Standard Schema inputs with a Zod object and import `z` directly
from `zod`; Harness does not re-export it. Object schemas are parsed before a Tool runs and
converted to JSON Schema once when the agent builds.

`session.input()` queues eagerly. Its handle exposes `completed` and `consume()`, so work does not depend on a consumer pulling `stream()`. Overlapping ordinary inputs remain FIFO; a matching approval or response resumes the exact retained Tool plan. Abort a turn with the `AbortSignal` passed to that `input()`.

Capabilities may add instructions, Tools, and ordered Step middleware. `setup` returns those contributions synchronously; load config or credentials before `.with()`, then `build()` validates, merges, and seals. Middleware can append request context, hide Tools, select a bound Model, deny calls, require interaction or preflight, and tripwire execution. It receives one-based turn and Step positions, so applications own execution budgets and may end a Step or Session with a policy tripwire. The harness has no automatic turn, Step, or wall-clock timeout. Middleware cannot add Tools during a Session or dispatch adapters directly.

The package intentionally does not own persistence, restart recovery, credentials, transports, provider conversion, background jobs, or detached Tool work.

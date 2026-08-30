# `@nylorun/harness`

`@nylorun/harness` is a small, provider-neutral TypeScript loop for model calls and tools. Compose
an agent from a model adapter and named capabilities; keep provider clients, stores, HTTP, and
credentials in ordinary application code.

> **Experimental beta.** Install with `npm install @nylorun/harness@beta`.

```ts
import { Agent, model, tool } from "@nylorun/harness";
import { z } from "zod";

const adapter = model(async (call) => provider.complete(call));
const echo = tool({
  name: "echo",
  description: "Echo text",
  parameters: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ kind: "completed", output: text }),
});

const agent = Agent(adapter)
  .use({ id: "echo", instructions: ["Use echo when asked."], tools: [echo] })
  .build();

const result = await agent.run().input("Echo hello").completed;
```

## Design boundaries

- **Capabilities** declare model-visible tools, instructions, context, and candidate review through
  `.use()`.
- **Services** are dependencies you construct and pass to capabilities, such as a store, MCP client,
  or container runner.
- **Host code** owns transport, persistence, credentials, and background work.
- **Harness core** owns the loop, validation, scheduling, and recording invariants.

See [Examples](../examples/README.md) for complete agents and [CHANGELOG.md](./CHANGELOG.md) for
release notes.

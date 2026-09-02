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

const agent = Agent({
  id: "echo",
  name: "Echo",
  instructions: "Use echo when asked.",
})
  .use({ id: "echo", tools: [echo] })
  .with(adapter)
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

## Model adapter translators

For OpenAI-compatible endpoints, keep transport and credentials in host code while Harness maps its
canonical model call and candidate:

```ts
import { chatCompletionsAdapter } from "@nylorun/harness/model/adapters";

const adapter = chatCompletionsAdapter(async (body, call, { signal }) => {
  const response = await fetch("https://example.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "my-model", ...call.model?.config, ...body }),
    signal,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
});
```

`toResponses` / `fromResponses` / `responsesAdapter` support direct OpenAI Responses transport.
`toMessages` / `fromMessages` / `anthropicAdapter` support direct Anthropic Messages transport;
`anthropicAdapter` requires an explicit `defaultMaxOutputTokens`. These translators support text and
JSON tool loops only. Provider-native continuation state, streaming, images, and cache controls stay
in application integrations.

```ts
const responses = responsesAdapter((body, call, { signal }) =>
  openai.responses.create({ model: "gpt-5.6", ...call.model?.config, ...body }, { signal }),
);

const messages = anthropicAdapter({
  defaultMaxOutputTokens: 1_024,
  send: (body, call, { signal }) =>
    anthropic.messages.create(
      { model: "claude-sonnet-4-5", ...call.model?.config, ...body },
      { signal },
    ),
});
```

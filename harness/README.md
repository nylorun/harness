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
  inputSchema: z.object({ text: z.string() }),
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

## Media input and adapter preparation

Harness preserves ordered, JSON-safe media references without storing, fetching, validating, or
transforming attachments. Submit mixed input with text and opaque host-owned references:

```ts
await agent.run().input({
  content: [
    { type: "text", text: "Describe this chart." },
    {
      type: "media",
      mediaType: "image/png",
      reference: { url: "https://cdn.example.com/chart.png" },
    },
  ],
}).completed;
```

Middleware can inspect `request.arrivals`, tripwire application policy, or select a model. The
canonical `ModelCall` and transcript retain the same ordered parts. The bundled adapters map direct
URL image references and reject other media with `model.unsupported-content`; applications own
uploads, provider file IDs, and any conversion through a custom adapter.

Use `preparedModel()` when an adapter materializes a provider request from the canonical call. It
records one JSON-safe `model.prepared` observation after `model.requested`, so the host can observe
both the portable input and provider-specific request without persisting provider wire data in the
session record.

## Structured terminal output

An ordinary `session.input()` may ask for one JSON-safe terminal result. Harness projects its JSON
Schema to the canonical `ModelCall`, validates an explicit adapter-produced JSON block locally, and
persists the validated value as the final output:

```ts
import { z } from "zod";

const completion = await session.input("Extract the launch facts.", {
  outputSchema: z.object({ date: z.string(), delayed: z.boolean() }),
}).completed;

const final = completion.events.find((event) => event.type === "final");
if (final?.type === "final") console.log(final.output);
```

Generic Harness model results never parse text that merely looks like JSON. A missing, ambiguous,
or invalid structured result ends with the stable `output.invalid` tripwire after the canonical
candidate is observed. It does not retry, repair prompts, or return a fallback. When the same call
requests an output schema, the Chat Completions and Responses adapters request their native
JSON-schema mode and decode that provider response as JSON; they do not select provider strictness.
Messages requires a custom prepared adapter and fails with `model.unsupported-output-schema`.

## Design boundaries

- **Capabilities** declare model-visible tools, instructions, context, and candidate review through
  `.use()`.
- **Services** are dependencies you construct and pass to capabilities, such as a store, MCP client,
  or container runner.
- **Host code** owns transport, persistence, credentials, and background work.
- **Harness core** owns the loop, validation, scheduling, and recording invariants.

Output retries, provider strictness, parsing fallbacks, guardrails, presentation, and generated
media/files remain application concerns implemented in host code, middleware, tools, or custom
adapters.

## Tool schemas

Tools accept direct Zod v4 schemas, synchronous Standard Schema values with JSON Schema conversion,
or an explicit `defineSchema()` contract for application-owned validators. `inputSchema` is required
and must describe an object; `outputSchema` is optional and may describe any JSON value. Harness
validates tool arguments before execution and validates completed output before recording it.

The validated result is one transparent value: the same JSON is recorded, observed, and sent to the
model. Keep private or UI-only data in host-owned services and return an explicit model-safe result.

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

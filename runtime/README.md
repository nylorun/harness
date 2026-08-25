# `@nylorun/runtime`

TypeScript authoring and deterministic build tooling for Nylo agents.

```ts
// agent/agent.ts
import { Run } from "@nylorun/runtime";
import { Harness } from "@nylorun/harness";

export default Run((options) => new Harness(options), {
  name: "reviewer",
  model: "anthropic/example"
});
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { nyloAgent } from "@nylorun/runtime";

export default defineConfig({ plugins: [nyloAgent()] });
```

The package supports authoring, structural validation, building `dist/agent.mjs` plus `dist/nylo.manifest.json`, and running the result. It does not deploy agents or ship a command-line/browser surface; install `@nylorun/studio` in `devDependencies` for `nylo` commands and the local Studio workspace.

`validateAgent` reads structure and data files only. `buildAgent` and `nyloAgent` execute the project's Vite config, definition, and tool modules with developer authority. Exactly one instruction source is required: inline `instructions` or `agent/AGENT.md`.

## Running

```ts
import { agent } from "./dist/agent.mjs";

const run = agent.session.start("What can you do?");
for await (const event of run.events) console.log(event.type);
console.log((await run.result).output);
```

The built module's named `agent` export is the runtime handle. Its default export is the
fetch-compatible HTTP door used by a generic host. Building binds the discovered tools, manifest,
and skill digests onto the named handle; a source definition imported directly from
`agent/agent.ts` remains unbound and refuses to start rather than silently losing capabilities.

It never builds on your behalf. The manifest and skill bodies are read from disk relative to the built module, so a local run needs the source tree rather than `dist/` alone; `agent.ready()` is where that read happens, and `start()` awaits it for you.

## Serving

```ts
import door, { agent } from "./dist/agent.mjs";
import { Fetchable } from "@nylorun/runtime";

app.mount("/agents/support", Fetchable(agent, {
  cors: { allowedOrigins: ["https://studio.example.internal"] }
})); // a Hono application
export default door;                              // a Workers, Bun or Deno entry point
```

`Fetchable` is a pure factory returning a value that is both callable and carries `fetch`, so one value works wherever a handler is expected. It serves the session-first contract: `POST /v1/sessions` with `{agent_id, message?}`, `GET` and later-message `POST /v1/sessions/:id`, bounded `GET /v1/sessions/:id/events?after=&limit=`, resumable `GET /v1/sessions/:id/stream` using `Last-Event-ID`, and `POST /v1/sessions/:id/cancel`.

Studio consumes the additional browser surface directly: `GET /v1/agent` returns protocol and build-manifest metadata, `GET /v1/sessions` returns persisted local record summaries, and `GET /v1/ag-ui/sessions/:sessionId` returns text-message history. `POST /v1/ag-ui` accepts standard AG-UI `RunAgentInput` and streams AG-UI SSE; `threadId` is the Nylo session ID. Sessions remain paused between successful runs and append every run to the same JSONL journal. Records remain readable after a local Agent Server restart, but reconstructing a live Harness Session from them is deferred. Cancellation and errors stay terminal. A file-backed local host may disclose only the relative `{ path: ".nylo/runs" }`; it never exposes an absolute or remote host path.

**It brings no authentication and no server.** Mount it behind whatever you already run; whether a given caller may reach a given session is a question only your application can answer. `cors.allowedOrigins` is optional and accepts exact HTTP(S) browser origins only; it supports REST, SSE, and browser preflight without wildcard or credential support. CORS is not authentication. Studio's development-only `nylo serve` binds it to loopback and says that nothing is guarding it.

The selected Harness is explicit. `@nylorun/harness` supplies Nylo's native loop, and is the Harness
this release ships. Runtime resolves the model and discovered tools before calling the deferred
factory. `nylo adapter probe` reports the selected declaration before any Session starts.

**Model gateway and credentials.** Model access is outbound runtime composition, independent of how a session arrived. Supply a custom `ModelGatewayAdapter` to `agent.withHost({ modelGatewayAdapter })`; otherwise the runtime chooses a local connection in this order: an explicitly configured `NYLO_MODEL_GATEWAY_URL`, an `OPENROUTER_API_KEY`, a supported direct credential, then LM Studio and Ollama on loopback. The gateway profile can configure an API key, authentication header and prefix, request-id header, JSON static headers, `NYLO_MODEL_GATEWAY_PROTOCOL`, and `NYLO_MODEL_GATEWAY_ACCESS_MODE`. Credentials are resolved for every outbound call from the environment first, then `.env`; their values are never reported.

The standard runtime transport supports `openai-chat-completions` (the default), `openai-responses`, and `anthropic-messages`. Set `NYLO_MODEL_GATEWAY_PROTOCOL` only for a named endpoint; existing OpenRouter, direct OpenAI-compatible, and loopback routes continue to use Chat Completions. Direct `anthropic/<model>` uses `ANTHROPIC_API_KEY` and Anthropic Messages. `NYLO_MODEL_GATEWAY_ACCESS_MODE` optionally labels a named endpoint as `external-gateway` or `private-or-local-endpoint`; otherwise loopback is inferred as private/local and other endpoints as external. The selected route, protocol, capabilities, and non-secret credential source are available at readiness and in model-call evidence.

The runtime uses portable Nylorun history and Nylorun-managed tools for every standard protocol. Provider-native Responses state, hosted provider tools, provider-managed compaction, cloud workload identity, and non-Node targets are deferred. A custom adapter remains the escape hatch for those capabilities, request signing, mutual TLS, token exchange, or another protocol. `NYLO_PROVIDER_BASE_URL` remains a deprecated one-release alias for `NYLO_MODEL_GATEWAY_URL`.

## Not in this release

No local sandbox (a tool declaring `sandbox: true` builds for hosting and is refused when a local
session starts), no local MCP resolution, no OS keychain, and no deployment-server generation.
`nylo dev --studio` records local sessions under `.nylo/runs/`. `memory/`,
`subagents/`, and root `evals/` remain reserved and refused.

# `@nylorun/agents`

TypeScript authoring and deterministic build tooling for Nylo agents.

```ts
// agent/agent.ts
import { Agent } from "@nylorun/agents";

export default Agent({
  name: "reviewer",
  model: "anthropic/example"
});
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { nyloAgent } from "@nylorun/agents";

export default defineConfig({ plugins: [nyloAgent()] });
```

The package supports authoring, structural validation, building `dist/agent.mjs` plus `dist/nylo.manifest.json`, and running the result. It does not deploy agents.

`validateAgent` reads structure and data files only. `buildAgent` and `nyloAgent` execute the project's Vite config, definition, and tool modules with developer authority. Exactly one instruction source is required: inline `instructions` or `agent/AGENT.md`.

## Running

```ts
import { openAgent } from "@nylorun/agents";

const agent = await openAgent(".");
const run = agent.run("What can you do?");
for await (const event of run.events) console.log(event.type);
console.log((await run.result).output);
```

`openAgent` opens a project that has **already been built** — it never builds on your behalf. It reads the bundle and manifest from `dist/`, re-derives tool descriptors from the live modules, and reads skill bodies from `agent/skills/`, so a local run needs the source tree rather than `dist/` alone.

The session loop it runs is the same one the hosted Agent Runtime imports. `createSession`, `fold`, `rehydrate` and `initialState` are exported for programs that host the loop themselves.

**Model and credentials.** A `creator/model` identity routes by its prefix. An `OPENROUTER_API_KEY` is preferred whenever present, because that is the path the hosted gateway takes; otherwise the prefix resolves to that provider's own API and its conventional variable. Credentials come from the process environment, then a `.env` beside the project. The resolved source is reported; the value never is.

Direct routing covers providers that serve `POST /chat/completions` — OpenAI, Groq, Mistral, DeepSeek, xAI, Together. **Anthropic and Google are not directly routable yet** and need an OpenRouter key; a model identity that cannot be reached is refused by name rather than failing as a protocol error.

## Not in this release

No local sandbox (a tool declaring `sandbox: true` is refused when the project is opened), no local MCP resolution, no `.babai/runs/` records, no OS keychain, and no deployment-server generation. `memory/`, `subagents/`, and root `evals/` are reserved and refused.

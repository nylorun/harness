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

The initial release supports authoring, structural validation, and building `dist/agent.mjs` plus `dist/nylo.manifest.json`. It does not run or deploy agents.

`validateAgent` reads structure and data files only. `buildAgent` and `nyloAgent` execute the project's Vite config, definition, and tool modules with developer authority. Exactly one instruction source is required: inline `instructions` or `agent/AGENT.md`.

The v0.1 package does not export local execution, sessions, adapters, event sinks, cancellation, records, durability APIs, or deployment-server generation. `memory/`, `subagents/`, and root `evals/` are reserved and refused.

# Building agents

Author definitions with `@nylorun/agents`. Run them against a **Tenant** on a
**Runtime Host**. A generated application depends only on `@nylorun/agents`
among Nylorun packages. Full terms:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

## Minimal application entry

```ts
// src/main.ts
import { connectAgents } from "@nylorun/agents";
import { agents } from "../agents/index.js";

await connectAgents({ agents }).ready;
```

`connectAgents` in application mode saves each agent, registers executor
credentials derived from the application key, and connects. The same file runs
under `nylorun dev` and as `node dist/src/main.js` in production.

## Connection

Resolution order for `createClient()` / `connectAgents({ agents })`:

1. Explicit `{ url, tenant, key }`
2. Environment: `NYLORUN_RUNTIME_URL`, `NYLORUN_TENANT`, and
   `NYLORUN_SERVER_KEY` or `NYLORUN_EXECUTOR_KEY` (all required if any is set)
3. Project link: `.nylorun/link.json` + `credentials.json` (application role)

```sh
# After linking a Project locally:
eval "$(npx nylorun runtime status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT

# Production / Cloud: set the three variables; do not ship executor tokens.
```

## Authoring

```ts
import { Agent, tool } from "@nylorun/agents";
import { z } from "zod";

export const assistant = Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "Be brief.",
  tools: [
    tool({
      name: "ping",
      input: z.object({}),
      async run() {
        return { ok: true };
      },
    }),
  ],
});
```

## Rules that matter

- Name the Tenant on every request. There is no default Tenant.
- Application and executor principals stay separate; derived executor tokens
  are never stored in the Project.
- Model credentials live in the Tenant vault — not in the browser, and not as
  ambient Host env after seed.
- Same agent id may exist independently in two Tenants; credentials never cross.
- Production installs only `@nylorun/agents` (and `@nylorun/core` transitively).
  CLI and Studio are `devDependencies`.

## Workflows

Compose agents and tools with `Chain`, `Switch`, `Parallel`, `Map`, and `Loop`.
A workflow is a registered runnable: same `export const agents`, `saveAgent`,
`createSession`, `input`, `observe`, `approve`, and `cancel` as an agent. There
is no workflow-specific run API. `nylorun dev` needs no extra steps.

```ts
import { Agent, Chain, Loop, Map, tool } from "@nylorun/agents";
import { z } from "zod";

const planner = Agent({
  id: "planner",
  instructions: "Return { tasks: string[] } for the feature.",
  outputSchema: z.object({ tasks: z.array(z.string()) }),
}).build();

const coder = Agent({
  id: "coder",
  instructions: "Implement the task. Return { summary }.",
  outputSchema: z.object({ summary: z.string() }),
}).build();

const openPr = tool({
  name: "open-pr",
  input: z.object({ summaries: z.array(z.string()) }),
  async run({ summaries }, ctx) {
    if (!(await ctx.approve("Open the PR?"))) throw new Error("Rejected");
    return { opened: true, count: summaries.length };
  },
});

export const shipFeature = Chain({
  id: "ship-feature",
  steps: [
    planner,
    Map({
      id: "implement",
      over: (plan) => plan.tasks,
      each: Loop({
        id: "code",
        run: coder,
        verify: () => ({ pass: true }),
        decide: ({ output }) => ({ output }),
      }),
    }),
    openPr,
  ],
});

export const agents = [shipFeature]; // registers the tree and referenced agents
```

| Primitive | Role |
| --- | --- |
| **Chain** | Steps in order |
| **Switch** | One case from a pure `on` key |
| **Parallel** | Fixed named branches at once → object |
| **Map** | One child per list item → array |
| **Loop** | Run → verify → decide until done |

Slots (`{ run, id?, input? }`) reshape data between nodes. JSON string input
becomes message `content`; other values become `data`. Workflows share one
sandbox per session (`PutSession.sandbox`, `session.sandbox`, `ctx.sandbox`).
Examples: `examples/agents/{chain,switch,parallel,map,loop,ship-feature}/`.
See [agents/README.md](../agents/README.md#workflows).

See [agents/README.md](../agents/README.md) for skills, MCP, sandbox, and
subagents; [MIGRATION.md](../MIGRATION.md#runtime-clients-and-admin-api-breaking-beta)
for the upgrade steps; [building a desktop client](./building-a-desktop-client.md)
for launcher and Admin API usage outside this repository.

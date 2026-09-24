# Building agents

Author definitions with `@nylorun/agents`. Run them against a **Tenant** on a
**Runtime Host**. A local Project attaches through a **Project link**. Full
terms: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

## Minimal client

```ts
import { Agent, createClient, tool } from "@nylorun/agents";
import { z } from "zod";

const assistant = Agent({
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

const client = createClient({
  url: process.env.NYLORUN_RUNTIME_URL!,
  key: process.env.NYLORUN_SERVER_KEY!,
  tenant: process.env.NYLORUN_TENANT!,
});
```

Or, after linking a Project:

```sh
eval "$(npx nylorun runtime status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

## Rules that matter for Tenants

- Name the Tenant on every request (`tenant` option or `NYLORUN_TENANT`). There
  is no default Tenant.
- Application and executor principals stay separate; both are Tenant-local.
- Model credentials live in the Tenant vault — not in the browser, and not as
  ambient Host env after seed.
- Same agent id may exist independently in two Tenants; credentials never cross.

See [agents/README.md](../agents/README.md) for skills, MCP, sandbox, and
subagents; [MIGRATION.md](../MIGRATION.md#runtime-tenants-breaking-beta) for the
breaking move to Host root + Tenant + Project link.

# Deploying a Hono agent application

Harness executes state-in/state-out. Runtime optionally adds sessions and HTTP delivery. Exporting a Hono app makes provider integration conventional; it does not supply durable storage, unlimited execution lifetime, or distributed coordination.

## Compatibility and verification

| Combination | Evidence | Limits |
|---|---|---|
| Node CLI + exported Hono app | Package, startup/reload/shutdown, and packed-starter checks | One host coordinates its sessions; local storage needs a persistent volume |
| Workers + portable imports + `httpModel` custom endpoint | Local Wrangler/workerd smoke, without `nodejs_compat`, with actual HTTP requests, environment bindings, tool dispatch and streaming | Local verification only; no deployed Workers support claim yet |
| Vercel Hono entrypoint | Follows official Hono deployment convention | Deployed Nylorun verification is pending provider access |
| Node `piModel` | Mock-provider tests including signed Gemini continuation and local credential precedence | Provider catalog is Node-only; individual remote providers require application testing |
| Portable `httpModel` | HTTP contract tests for OpenAI/custom and Anthropic, JSON output, cancellation and OpenAI previews | No portable media materialization; no OAuth/local credential discovery; no claim for every provider |

The portable HTTP adapter intentionally has a small verified surface. Supply `onModelCall` or `createModel` for another adapter. Harness can run independently of Runtime and Hono.

## Node or container hosting

```sh
npm ci
npm run build
npm ci --omit=dev
npm start
```

Ship `dist/`, the manifests/lockfile, and production dependencies. `nylorun start` imports `dist/src/index.js` and listens on `PORT` (default 3000). It loads `.env` without overriding process values, serves without Studio/development CORS, and drains Runtime hosts on orderly shutdown. The application closes its own database clients, subprocesses and other resources. SIGKILL cannot run cleanup.

By default sessions live in memory. For one process with durable local storage:

```ts
import { localSessions } from "@nylorun/runtime/node";
const runtime = new Runtime({ sessions: localSessions({ root: "/data/sessions" }) });
```

Mount `/data` on a persistent volume. Only one adapter may own that root. A crash leaves `.owner.lock`; confirm the process has stopped before manual removal. Completed and paused sessions restore; an active marker requires reconciliation. The adapter neither steals locks nor guarantees shared-filesystem coordination.

## Vercel

Keep `src/index.ts` with `export default app`; Vercel's Hono integration can recognize it without a custom Nylorun adapter or mandatory `vercel.json`. Follow the [official Hono guide](https://hono.dev/docs/getting-started/vercel) and [Vercel Hono documentation](https://vercel.com/docs/frameworks/backend/hono).

Use portable imports and API-key configuration for the smallest deployment:

```ts
import { Hono } from "hono";
import { Runtime, serveAgents } from "@nylorun/runtime";
import { agents } from "../agents/index.js";
const app = new Hono();
app.route("/agents", serveAgents({ agents, runtime: new Runtime() }));
export default app;
```

Set provider variables in project settings, then use `vercel deploy`. Vercel invokes the exported app; it does not run the persistent `nylorun start` process. Choose a SessionStore and a coordination strategy before depending on conversations across function instances. Memory is temporary; a shared database alone does not serialize competing runs.

Streaming is supported by the platform, subject to its current function lifetime and streaming limits. Configure those for your workload using [Vercel's streaming documentation](https://vercel.com/docs/functions/streaming-functions). Longer work needs an independently hosted execution mechanism or durable host, not a promise that every stream will remain open indefinitely.

## Cloudflare Workers

Use the portable package roots; keep `@nylorun/runtime/node`, filesystem assets, local OAuth, subprocess tools, and Node-only SDKs out of the Worker graph. Start with the [Hono Workers guide](https://hono.dev/docs/getting-started/cloudflare-workers).

```json
{
  "name": "my-agent",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-14",
  "vars": { "MODEL_PROVIDER": "openai", "MODEL": "your-model-id" }
}
```

```sh
npx wrangler secret put MODEL_PROVIDER_API_KEY
npx wrangler dev
npx wrangler deploy
```

Runtime reads request bindings through Hono's `context.env`. To select only the relevant bindings, provide `getEnvironment: c => ({ MODEL_PROVIDER: c.env.MODEL_PROVIDER, MODEL: c.env.MODEL, MODEL_PROVIDER_API_KEY: c.env.MODEL_PROVIDER_API_KEY, MODEL_PROVIDER_BASE_URL: c.env.MODEL_PROVIDER_BASE_URL })` to `serveAgents`. No process-global mutation is needed. Local smoke checks do not require Node compatibility flags.

For durable conversations, use a store plus a host with execution ownership appropriate to the platform (for example application-owned Durable Objects or a queue worker). Runtime's built-in coordinator is local to its instance. Memory survives only while that instance does; local filesystem storage is not a Worker persistence adapter. Check [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/) for CPU, request lifetime and resource constraints.

## Configuration, storage and infrastructure ownership

Use `MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY`, and optional `MODEL_PROVIDER_BASE_URL`. Custom endpoints require the base URL. Environment API keys need no credential files. Use provider secret facilities for keys. Native provider variables remain available as fallbacks. Node-only credential discovery and OAuth remain explicit adapter features.

The application owns route authorization and supplies fresh application info. Infrastructure owns ingress buffering/timeouts, distributed scheduling, streaming reconnection and execution lifetime. Request-attached Runtime execution cancels cooperatively on connection loss. Developers can compose a different host with Harness; managed Cloud Runtime is future work.

## Repeat verification

After building, run `npm run test:workers` for the local workerd integration and `node create-agent/scripts/smoke-starter.mjs` for the installed tarball/Node path. For a deployed test application, run `node scripts/smoke-deployed.mjs https://your-app.example/agents` (optionally supply `SMOKE_BEARER_TOKEN` through the environment). Only record deployed support after that verification and provider-specific storage/lifetime tests pass. [Migration notes](MIGRATION.md) explain incompatible saved-state formats and archived history.

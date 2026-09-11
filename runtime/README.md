# @nylorun/runtime

Portable agent lifecycle, a mountable Hono protocol router, pi-ai model providers, and the `nylorun` CLI. Runtime has no Harness dependency.

```ts
import { Runtime, serveAgents } from "@nylorun/runtime";

const runtime = new Runtime();
app.route("/agents", serveAgents({ agents, runtime }));
```

`Runtime` is the primitive stack: model adapter (`piModel` by default), observer (`jsonlObserver` per session by default), and durability (`localJsonl` by default). Session files live together under `.data/sessions/<agent>/<session>/` as `events.jsonl` and `observe.jsonl`. Agents bind only when served.

The application owns Hono composition, authentication, CORS, logging, process lifecycle, and deployment. Runtime owns agent sessions, durability, media, and AG-UI/session protocol routes. Graceful shutdown is optional: if the application installs signal handlers and wants to drain live sessions, flush pending journal writes, and run optional agent cleanup, it should await `runtime.close()`. An application that does not install handlers exits normally on its host's shutdown policy; `runtime.close()` does not run on crash, OOM, or SIGKILL.

Runtime publishes root-relative discovery and endpoint URLs. Mounting below root requires the matching public prefix, so Studio and other clients can resolve those URLs against any configured agent-server URL:

```ts
app.route(
  "/api/agents",
  serveAgents({ agents, runtime, basePath: "/api/agents" })
);
```

`getActor(context)` supplies an optional actor id and session context for newly created sessions. `getRequestMetadata(context)` supplies JSON-safe metadata for inbound messages. Application middleware remains responsible for authorizing every agent route.

## Commands

- `nylorun configure`
- `nylorun studio --agent-url http://localhost:3000/agents [--port 4161] [--no-open]`

Studio attaches to an application you run. Use your own TypeScript/build tooling and a Node adapter such as `@hono/node-server` when applicable. `projectAsset("agents/skills/catalog")` resolves bundled application assets from source or a compiled `dist/` deployment.

Provider credentials are stored in `.env/auth.json`, and selection in `config/model.json`. `nylorun configure` can run before an agent graph is importable.

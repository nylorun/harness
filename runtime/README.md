# @nylorun/runtime

Portable agent lifecycle, a mountable Hono protocol router, pi-ai model providers, and the `nylorun` CLI. Runtime has no Harness dependency.

```ts
import { Runtime, serveAgents } from "@nylorun/runtime";

const runtime = new Runtime();
app.route(
  "/agents",
  serveAgents({ agents, runtime })
);
```

`Runtime` is the primitive stack: model adapter (`piModel` by default), observer (`jsonlObserver` per session by default), and durability (`localJsonl` by default). Session files live together under `.data/sessions/<agent>/<session>/` as `events.jsonl` and `observe.jsonl`. Agents bind only when served.

The application owns Hono composition, authentication, CORS, logging, process lifecycle, and deployment. Runtime owns agent sessions, durability, media, and AG-UI/session protocol routes. Graceful shutdown is optional: if the application installs signal handlers and wants to drain live sessions, flush pending journal writes, and run optional agent cleanup, it should await `runtime.close()`. An application that does not install handlers exits normally on its host's shutdown policy; `runtime.close()` does not run on crash, OOM, or SIGKILL.

Runtime infers root-relative discovery and endpoint URLs from the Hono mount on each request. Mount at `/agents` or `/api/agents` without repeating that path in `serveAgents`. An explicit `basePath` remains available when a reverse proxy rewrites the public prefix.

`nylorun dev` enables local Studio connections automatically by setting `NYLORUN_DEV=1` for its child application. This allows HTTP/HTTPS browser origins on `localhost`, `127.0.0.1`, or `[::1]`, including Studio's fallback ports. Ordinary production startup does not enable this policy; the application owns production CORS and authorization.

`getActor(context)` supplies an optional actor id and session context for newly created sessions. `getRequestMetadata(context)` supplies JSON-safe metadata for inbound messages. Application middleware remains responsible for authorizing every agent route.

## Commands

- `nylorun configure`
- `nylorun dev [--no-studio] [--no-open]`
- `nylorun studio --agent-url http://localhost:3000/agents [--port 4161] [--no-open]`

Studio attaches to an application you run. Use your own TypeScript/build tooling and a Node adapter such as `@hono/node-server` when applicable. `projectAsset("agents/skills/catalog")` resolves bundled application assets from source or a compiled `dist/` deployment.

Provider credentials are stored in `.env/auth.json`, and selection in `.env/model.json`. `nylorun configure` can run before an agent graph is importable.

`nylorun dev` runs project-local `tsx watch src/index.ts`, waits for `/agents/v1/agents`, then starts project-local Studio. `PORT` defaults to 3000. `--no-studio` runs just the application; `--no-open` keeps the browser closed. Both flags can be combined. Ctrl-C stops both processes.

### Upgrading an existing starter

After upgrading Runtime to a release containing `nylorun dev`, change the development script to `"dev": "nylorun dev"` and remove `dev:app` and `scripts/dev.mjs`. Remove the duplicated `basePath` option for normal Hono mounts.

Run `npm run configure` to move model selection to `.env/model.json`. Runtime reads the legacy `config/model.json` only when the new file is absent. Successful configuration removes the legacy file and its directory only if empty; credentials remain in `.env/auth.json`. Do not set `NYLORUN_DEV` in production.

The starter now uses one `tsconfig.json` with `rootDir: "."` and `outDir: "dist"`. Remove `noEmit` from that file and use `tsc --noEmit` for checks. Change the build's compiler invocation to `tsc -p tsconfig.json` before deleting `tsconfig.build.json`. Keep your existing asset-copy step. Projects whose checks include tests may retain separate build configuration.

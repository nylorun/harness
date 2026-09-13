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

Runtime publishes root-relative discovery and endpoint URLs. It infers the Hono
mount from each request URL (so a separate consumer `hono` install still works).
Mount at `/agents` or `/api/agents` without repeating that path in `serveAgents`.
Pass explicit `basePath` when a reverse proxy rewrites the public prefix.

`nylorun dev` enables local Studio connections automatically by setting `NYLORUN_DEV=1` for its child application. This allows HTTP/HTTPS browser origins on `localhost`, `127.0.0.1`, or `[::1]`, including Studio's fallback ports. Ordinary production startup does not enable this policy; the application owns production CORS and authorization.

`getActor(context)` supplies an optional actor id and session context for newly created sessions. `getRequestMetadata(context)` supplies JSON-safe metadata for inbound messages. Application middleware remains responsible for authorizing every agent route.

## Commands

- `nylorun configure`
- `nylorun dev [--no-studio] [--no-open]`
- `nylorun start [entry]` (default: `dist/src/index.js`)
- `nylorun studio --agent-url http://localhost:3000/agents [--port 4161] [--no-open]`

Export your Hono application with `export default app`. The CLI supplies the Node server adapter. `nylorun dev` watches `src/index.ts`, waits for `/agents/v1/agents`, and starts project-local Studio. `PORT` defaults to 3000. `--no-studio` runs only the application; `--no-open` keeps the browser closed. Ctrl-C stops both processes. `nylorun start` serves the built app without Studio or development CORS.

### Environment configuration

Copy `.env.example` to `.env` and fill it in, or run `nylorun configure` before your agent graph is importable:

```dotenv
MODEL_PROVIDER=custom
MODEL=your-model-id
MODEL_PROVIDER_API_KEY=your-key
MODEL_PROVIDER_BASE_URL=https://your-provider.example/v1
```

`MODEL_PROVIDER_BASE_URL` is required only for `MODEL_PROVIDER=custom`; omit it for built-in providers. `configure`, `dev`, and `start` load `.env` before importing the app. Existing process variables win; a missing `.env` is valid. `.env.local` is ignored by Git but is not automatically loaded. Direct imports of Runtime do not load dotenv files.

Explicit `piModel({ selection })` options take precedence over environment selection. Environment selection takes precedence over legacy files; incomplete selection produces an error. `MODEL_PROVIDER_API_KEY` overrides provider-native variables such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, which override stored credentials. API-key deployments require no credential files. Supply the same variables through your hosting provider's environment settings.

The optional wizard writes selection and entered API keys to `.env`, preserving unrelated configuration. It reuses environment credentials without copying them into the file. OAuth is an alternative where supported; its credentials and refresh state live in ignored `.nylorun/auth.json`. Keep `.env` and `.nylorun/` private.

### Upgrading an existing starter

Migration is manual; the CLI will not replace a legacy `.env` directory.

1. Back up the existing `.env/` directory to a private location outside the project before replacing it with a file. Preserve any `config/model.json` too.
2. Translate `model.json` fields `provider`, `model`, and `custom.baseUrl` into `MODEL_PROVIDER`, `MODEL`, and `MODEL_PROVIDER_BASE_URL`. Copy API keys into `MODEL_PROVIDER_API_KEY` or provider-native variables. Replace the old `NYLO_CUSTOM_API_KEY` variable with `MODEL_PROVIDER_API_KEY`.
3. Merge `integrations.env` variables into `.env`. Move OAuth records into `.nylorun/auth.json`. Add `.env`, `.env.local`, and `.nylorun/` to `.gitignore`; remove the old `.env/` exceptions.
4. Replace the entrypoint's `serve(...)` call and Node adapter import with `export default app`. Set scripts to `"dev": "nylorun dev"` and `"start": "nylorun start"`. Remove the application's `@hono/node-server` dependency if unused elsewhere. Keep your build and asset-copy steps.

Runtime retains legacy `.env/model.json`, `config/model.json`, and `.env/auth.json` reads for existing applications using their own launcher. It does not automatically move or delete these files. Use the matching Runtime release pinned by the new creator; older releases cannot launch an exported app.

The exported app follows Hono composition conventions. This change does not establish verified serverless persistence, execution lifetime, or Workers support. `projectAsset()` resolves bundled assets from source or compiled deployments.

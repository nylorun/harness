# @nylorun/runtime

Optional hosting for stateless Harness agents: session coordination, replaceable storage, Hono routes, model adapters, and the Node CLI. Runtime depends directly on canonical Harness types; Harness does not depend on Runtime.

```ts
import { Hono } from "hono";
import { Runtime, serveAgents } from "@nylorun/runtime";
const runtime = new Runtime();
const app = new Hono();
app.route("/agents", serveAgents({ agents, runtime }));
export default app;
```

The default is `memorySessions()` and no file observer. Portable imports do not initialize the filesystem. `httpModel()` supports text/tool/structured-output requests to OpenAI-compatible and Anthropic HTTP endpoints using injected environment values or process variables where available. It requires API keys; media inputs require a supplied media-aware adapter. The Node CLI installs `piModel()` for its broader provider catalog, local credential fallback, OAuth, and media support. Direct portable imports do not load dotenv or local credentials.

## Storage and coordination

```ts
import { localSessions, piModel } from "@nylorun/runtime/node";
const runtime = new Runtime({
  sessions: localSessions({ root: ".data/sessions" }),
  onModelCall: piModel(),
});
```

A `SessionStore` provides `get(agentId, sessionId)`, atomic `put(agentId, sessionId, document)`, and `list(agentId)`. StoredSession includes Runtime metadata, Harness state, an active marker, and committed event history. Stores implement data operations only. The built-in SessionHost serializes inputs, cancels and awaits active work before replacement, persists accepted inputs before execution, and commits terminal state before reporting success. It restores completed and explicitly paused sessions; active markers found after a crash require reconciliation. Legacy event-only records remain archived history.

`localSessions` exclusively owns its root through `.owner.lock`. Multiple owners are rejected, including adapters in the same process. Writes use temporary files and atomic replacement; lost ownership stops writes. Orderly `runtime.close()` releases the matching lock. Locks are never stolen by age or PID: after a crash, confirm the owner stopped before manually removing the lock. No shared-filesystem or multi-replica guarantee is made.

The host's scheduling scope is one process. A shared store is not a distributed scheduler. Advanced applications can use `SessionHost` without Hono, reuse `agUiEvents()` protocol translation, or compose Harness with their own host. Managed Cloud Runtime remains future work.

## Scope, delivery, and resources

Application middleware authorizes every route. `getScope(context)` supplies fresh trusted application scope for each invocation; Runtime adds `sessionId`. `getEnvironment(context)` can supply per-request provider bindings without changing process globals. Neither scope nor live resources are implicitly model-visible. `getActor` remains a convenience for userId; use `getScope` for typed application identity.

Runtime delivers ordered observations incrementally, separately from committed history. `tokens: true` enables provisional text previews on compatible model adapters; the default is off. `createModel({ environment, media, onPreview })` supplies preview support for custom adapters. Studio shows drafts separately and discards them on settlement; accepted output remains authoritative. Partial tool arguments never dispatch tools.

Delivery limits default to 64 KiB of preview data per model invocation (also bounding queued previews), and 256 events or 1 MiB of queued execution/control data. Configure them with `delivery: { previewBytes, eventCount, eventBytes }`. Preview overflow suppresses further previews for that model invocation and emits an incomplete marker. Authoritative overflow closes the subscription. Neither path blocks model consumption; request-attached execution is cooperatively cancelled on disconnect. Independent execution/reconnection belongs to a custom host.

Runtime owns controllers and its store lifecycle. It does not close application tools, databases, browsers, or subprocesses. The Node launcher drains registered Runtime hosts during orderly shutdown; application resource cleanup remains explicit. Imports never open a listening socket. Root-relative discovery supports ordinary Hono mounts; use `basePath` for a rewriting proxy. Production authentication, CORS, ingress timeouts, and TLS belong to the application and infrastructure.

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

The exported app follows Hono composition conventions. See [deployment verification and limits](../DEPLOYMENT.md) and the [breaking migration guide](../MIGRATION.md). Node-only `projectAsset()` resolves bundled assets from source or compiled deployments.

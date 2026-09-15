# Migrating to stateless execution

This is a coordinated breaking beta for Harness, Runtime, Studio, and the creator. Upgrade them as a compatible set. Existing SessionRecord files are not the new ExecutionState format; keep backups and treat legacy event-only records as archived history.

| Previous interface | Replacement |
|---|---|
| `agent.run()` returns a Session; `session.input(...).completed` | `await agent.run({ input, state?, onModelCall })` returns an outcome and state |
| Harness sessions, submission queues, interruption | Runtime `SessionHost`, or your own application host |
| Session identity/context in Harness | Fresh `scope` on every invocation; model-visible `request.context` remains explicit |
| Per-turn/per-run `outputSchema` | `Agent({ outputSchema })` |
| Capability resource factories/disposal | Application-created dependencies and application-owned shutdown |
| Dynamically exposed executable closures | Registered ordinary tools or `defineToolFamily()` with serializable bindings |
| Session recorder/event replay | Awaited `record(state)` callback; no automatic replay of uncertain effects |
| Default local persistence and file observer | Memory sessions and no file observer; explicitly opt into Node adapters |
| Root imports of local adapters, assets, or `piModel` | Imports from `@nylorun/runtime/node` |

## Update execution

Handle all four result statuses. A pause is a finished invocation: persist its state and resume through another `run()` call with a correlated approval, response, or deferred settlement. A cancellation is also a settled outcome. Keep the latest returned state for subsequent turns. Remove calls to Harness `stop()`, `close()`, public steps, queues, and completion handles.

Pass a fresh trusted scope to middleware and tools. Rename tool/model `context.sessionId` uses: `context.executionId` correlates Harness execution; Runtime's session ID is available through application scope. Do not infer authorization from saved state. Tools must authorize the original bound resource with the current principal.

Final output schemas now describe the agent definition. If different runs require different contracts, build distinct agent definitions. Agent `executionVersion` and family `version` identify incompatible behavior changes; preserve compatible deployed definitions to finish existing pauses or reconcile them explicitly.

## Update hosting

```ts
import { Runtime, serveAgents } from "@nylorun/runtime";
import { localSessions, piModel } from "@nylorun/runtime/node";

const runtime = new Runtime({
  sessions: localSessions({ root: ".data/sessions" }),
  onModelCall: piModel(),
});
app.route("/agents", serveAgents({ agents, runtime }));
export default app;
```

Omit `sessions` for memory-only storage. Local storage atomically replaces `<agent>/<session>.json` and holds `.owner.lock` for the root. Only one adapter owns a root, even within one process. `runtime.close()` drains the host and closes its store. The CLI calls it on orderly shutdown. The application separately closes its tools and external resources. A killed process leaves a lock: confirm it has stopped before manually removing that lock. Never delete a live owner's lock.

Completed and paused new-format sessions restore. A durable active marker after a crash becomes interrupted and requires application reconciliation or a new session. Legacy `events.jsonl` directories remain readable as archived history; they cannot be resumed automatically. No files are silently migrated.

A shared SessionStore does not provide distributed ownership. Choose a host/coordinator appropriate to your database, queues, and streaming infrastructure before running concurrent replicas against the same sessions.

## Environment and startup

Keep `.env.example` committed; `.env`, `.env.local`, and `.nylorun/` ignored. Only `.env` is automatically loaded by the CLI. Use `MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY`, and optional `MODEL_PROVIDER_BASE_URL`. Replace the former `NYLO_CUSTOM_API_KEY` manually with `MODEL_PROVIDER_API_KEY`; there is no alias.

For a legacy `.env/` directory: back it up privately, translate model selection and keys into these variables, merge integration variables, and move OAuth records to `.nylorun/auth.json`. Environment API keys need no credential files. Keep the exported Hono app, `nylorun dev`, and `nylorun start`; serverless platforms use their conventional Hono entrypoint instead of the Node launcher.

See [deployment](DEPLOYMENT.md) for the distinction between compatible imports, durable storage, execution lifetime, and coordination.

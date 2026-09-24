# Scoped hooks and manifest schema 4

`beforeModelCall` and `afterModelCall` are replaced by two verbs with an explicit scope.
There are no compatibility aliases.

| Previous | Replacement |
| --- | --- |
| `.beforeModelCall(fn)` | `.before("step", fn)`, or `.before("turn", fn)` when the decision holds for the whole turn |
| `.afterModelCall((args, ctx) => …)` | `.after("step", ({ text, toolCalls, info, state, step, attempt }) => …)` (one argument) |
| `capability({ beforeModelCall, afterModelCall })` | `capability({ before: { turn?, step? }, after: { step?, turn? } })` |
| — | `after("turn", ({ text, output, attempt }) => TurnDecision)` for the final answer |
| Manifest `beforeModelCall` / `afterModelCall` booleans | `capabilities[].hooks: { at, scope }[]` in `manifestSchemaVersion: 4` |
| Action kinds `beforeModelCall` / `afterModelCall` | Action kind `hook` with `hook: { at, scope, capabilityIds }` |
| `BeforeModelCallFn` / `AfterModelCallFn` | `BeforeHook<scope>` / `AfterHook<scope>` |

`before("turn")` runs once per turn and its `Patch` applies to every model call in that
turn; `before("step")` and `after("step")` run on every model call. In a Runtime, every
capability registered at one hook point runs in a single executor action, so a hook point
costs one round trip per turn or per model call.

Hooks may run more than once when a delivery is retried: an expired hook claim is offered
again instead of becoming uncertain. Keep side effects in tools.

`retry` now retries. From `after("step")` it denies the proposed tool calls with the feedback,
or sends a text answer back with the feedback as a message; from `after("turn")` it sends the
final answer back. The engine does not cap retries: bound them with the `attempt` argument,
for example `attempt < 2 ? { retry: "…" } : { block: "…" }`.

Rebuild agents to publish schema 4 manifests. `Agent.from` rejects schema 3. On startup the
Runtime cancels pending `beforeModelCall` / `afterModelCall` actions and fails any turn that
was in flight under a schema 3 manifest; start new sessions after upgrading. The durable
engine version is now `hosted-2`, because hook effect ids changed.

# Runtime Tenants (breaking beta)

> **DRAFT (WS-I Wave 1).** Companion design §21 was not available; this section
> is assembled from the Runtime Tenants implementation plan (Wave 0 contracts,
> WS-F/WS-I). Finalize in Wave 3 against merged CLI and Host behaviour.
> Vocabulary: [runtime/src/CONTEXT.md](./runtime/src/CONTEXT.md).

One **Runtime Host** process serves many isolated **Tenants**. A Project attaches
through a **Project link** (`.nylorun/link.json` + `credentials.json`), not by
owning a per-project SQLite "scope".

| Previous | Replacement |
| --- | --- |
| Project / global **scope** (`.nylorun/` SQLite beside the project, or `~/.nylorun` with `--global`) | Host root (`NYLORUN_HOME` or `~/.nylorun`) + Tenant under `tenants/<id>/` + Project link |
| `--global`, `--db`, `NYLORUN_SQLITE_PATH`, `configure --global` | Removed |
| `.nylorun/local-credentials.json` | `.nylorun/credentials.json` (0600) + `.nylorun/link.json` |
| `/health.scopeId` | `/health.hostId` + `/health.protocol` (`min` / `max` / `features`) |
| Exact package-version equality for CLI ↔ Runtime | `Nylorun-Protocol` + `checkCompatibility` (protocol `2`, feature `runtime-tenants`) |
| `createClient({ url, key })` | `createClient({ url, key, tenant })` (or `NYLORUN_TENANT`) |
| `/v1/host/model`, `/model/selection`, `/models`, `/providers`, `/sandbox` | `/v1/tenant/…` |
| `NYLORUN_EXECUTORS_JSON` at Host startup | Removed; `PUT /v1/executors` with the application principal only |
| `startRuntime` / `createRuntime` | `startEphemeralRuntime()` for tests/embeds; CLI starts `@nylorun/runtime/server` |
| Env overrides for vault KEK, sandbox backend, model gateway on the Host process | Tenant paths / `TenantConfig` / `PUT /v1/tenant/config/seed` |
| Sandbox name prefix `nylorun-<scopeId>-` | `nylorun-<tenant-id>-` |

### What to do when upgrading

1. Upgrade `@nylorun/core`, `@nylorun/runtime`, `@nylorun/agents`, `@nylorun/cli`,
   and `@nylorun/studio` together (breaking beta set). Protocol `2` with feature
   `runtime-tenants` is required.
2. Stop old scoped Hosts (`nylorun down` from each former project/global data
   directory). Start the new Host once: `nylorun runtime up`.
3. From each Project, run `nylorun dev` (or the Project link flow) so a Tenant
   is created and `.nylorun/link.json` / `credentials.json` are written. Do not
   reuse an old Tenant id from another checkout.
4. Point custom clients at `createClient({ url, key, tenant })` and send
   `Nylorun-Tenant` / `Nylorun-Protocol` on every request. Update Studio callers
   to `startStudio({ runtimeUrl, serverKey, tenant: { id, name } })`.
5. Replace `/v1/host/*` Tenant routes with `/v1/tenant/*`. Move any embedding
   tests from `startRuntime` to `startEphemeralRuntime`.
6. Export linked env with:
   `eval "$(npx nylorun runtime status --env)"`.

Existing per-project SQLite files and KEKs are **not** auto-imported into
Tenants in this draft. Prefer new Tenants and new sessions after upgrading;
session export/import remains deferred.

### Microsandbox cleanup (old scope prefixes)

> **DRAFT.** Exact operator command pending design §21 / Wave 3. After upgrade,
> remove leftover microsandbox entries whose names still use the old
> `nylorun-<scopeId>-` prefix (digest of a former SQLite path). New sandboxes
> use `nylorun-<tenant-id>-`. Until the CLI ships a dedicated cleanup verb,
> list and delete obsolete microsandbox names with the microsandbox tooling you
> already use for this machine, matching only the old prefix pattern — never
> delete names that start with a current Tenant id (`tn_…`).

# Package architecture beta migration

The [design document](docs/design/package-architecture.md) defines the new structure.
Cloud upgrades published packages from npm independently. Upgrade the tested
package combination in `create-agent/compatibility.json`.

| Previous | Replacement |
| --- | --- |
| `@nylorun/harness/define` or authoring from its root | `@nylorun/agents/define` (applications), `@nylorun/core/define` (infrastructure) |
| `@nylorun/harness/contracts` | `@nylorun/core/contracts` |
| Harness hash/protocol metadata | `@nylorun/core/compatibility` |
| Harness checkpoint compatibility | `@nylorun/harness/compatibility` |
| Runtime-owned `nylorun` | Install `@nylorun/cli`; commands are unchanged |

SDK root imports remain supported. Studio imports `agents/client`. Runtime has no
SDK dependency. SDK has no engine dependency. Bindings use `getBinding()` rather
than shared module object identity; only manifests serialize. The package split
does not change wire formats, canonical manifest hashes, or stored checkpoints.

Generated applications use agents and CLI in production dependencies; Studio is
optional development tooling. Custom runtime host code keeps a direct runtime
and core dependency. Do not copy private compiled definition objects: use
`bindingFromAgent()` from `harness/run` for explicit execution.

No npm release or deployment is performed by this migration.

## Earlier session-first migration

# Local Runtime beta migration

Upgrade the harness, SDK, Runtime, Studio, and creator as the tested compatible set in `create-agent/compatibility.json`. This migration changes public entry points and the session protocol.

1. Import `Agent` and `tool` from `@nylorun/agents`. Export `agents` from `agents/index.ts`. Keep model selection in Runtime configuration.
2. Remove the starter's Hono application and old `Runtime` / `serveAgents` / `openSession` imports. Definitions no longer expose `agent.run()`.
3. `nylorun start` is removed. Use `nylorun serve [entry]` to run the compiled build (same `dist/agents/index.js` default) and change `scripts.start` to `nylorun serve`. The Runtime is now its own persistent process: `nylorun up` starts it, `nylorun down` stops it, `nylorun runtime status` reports it, and `dev`/`serve` start it for you and leave it running. Runtime defaults to loopback port 8787; under Runtime Tenants the Host root is `NYLORUN_HOME` / `~/.nylorun` and the Project keeps only a link under `.nylorun/`.
4. Update custom applications to SDK `createClient` and session commands with stable idempotency keys. Trusted servers supply `ownerUserId`; input text uses `content`. With Runtime Tenants, pass `tenant` (see section above).
5. Custom connected executors use `connectAgents({ agents, runtime: { url, key, tenant } })`. Supply executor credentials, separate from application credentials. The local CLI provisions these automatically.
6. Studio now uses canonical history and authenticated SSE through its local proxy. Attach with `nylorun studio`, which resolves the Project link; `--runtime-url` still overrides the Host URL. Remove AG-UI and legacy manifest endpoint configuration.

Keep credentials in gitignored `.nylorun/`; provider configuration uses `.env` only as a one-time seed into the Tenant vault. Keep backups of old SessionRecord/event files. They are not automatically converted to new SQLite checkpoints. Session export/import and migration tooling are deferred. Start new sessions after changing definitions or implementations. Because the Host now outlives `dev`, a source change re-registers agents and reconnects executors rather than restarting the Host.

Explicit in-process engine execution remains available to host authors through `@nylorun/harness/run`; it is not loaded by the application SDK. OSS and Cloud consume the harness independently.

The release workflow covers local text and ordinary tools. Advanced examples remain source references outside the default registry. Media, approvals UI, deployment recipes, and broad recovery/conformance gates remain for later releases. Subagents (agents used as tools, one level deep) ship with this branch; see [the SDK](agents/README.md).

## Execution API rename

Replace `@nylorun/harness/engine` imports with `@nylorun/harness/run`. Rename `runHosted` to `runDurable`, `createHostedCheckpoint` to `createDurableCheckpoint`, `HostedCheckpoint` / `HostedResult` to `DurableCheckpoint` / `DurableResult`, and `EngineHost` to `DurableHost`. Rename `EngineBinding`, `EngineRunOptions`, and `createEngineState` to `RunBinding`, `BoundRunOptions`, and `createRunState`. There are no compatibility aliases.

Durable execution reconstructs progress from a checkpoint and individually journaled effect outcomes; the host must persist both. Existing checkpoint fields and `ENGINE_VERSION = "hosted-1"` remained compatible at the time of this rename; scoped hooks later moved the engine to `hosted-2`.

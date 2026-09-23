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
3. `nylorun start` is removed. Use `nylorun serve [entry]` to run the compiled build (same `dist/agents/index.js` default) and change `scripts.start` to `nylorun serve`. The Runtime is now its own persistent process: `nylorun up` starts it, `nylorun down` stops it, `nylorun runtime status` reports it, and `dev`/`serve` start it for you and leave it running. Runtime defaults to loopback port 8787 in project-scoped `.nylorun/`.
4. Update custom applications to SDK `createClient` and session commands with stable idempotency keys. Trusted servers supply `ownerUserId`; input text uses `content`.
5. Custom connected executors use `connectAgents({ agents, runtime: { url, key } })`. Supply scoped executor credentials, separate from server credentials. The local CLI provisions these automatically.
6. Studio now uses canonical history and authenticated SSE through its local proxy. Attach with `nylorun studio`, which resolves the active scope; `--runtime-url` still overrides it. Remove AG-UI and legacy manifest endpoint configuration.

Keep credentials and SQLite in gitignored `.nylorun/`; provider configuration uses `.env`. Keep backups of old SessionRecord/event files. They are not automatically converted to new SQLite checkpoints. Session export/import and migration tooling are deferred. Start new sessions after changing definitions or implementations. Because the Runtime now outlives `dev`, a source change re-registers agents and reconnects executors rather than restarting the host.

Explicit in-process engine execution remains available to host authors through `@nylorun/harness/run`; it is not loaded by the application SDK. OSS and Cloud consume the harness independently.

The release workflow covers local text and ordinary tools. Advanced examples remain source references outside the default registry. Media, approvals UI, subagents, deployment recipes, and broad recovery/conformance gates remain for later releases.

## Execution API rename

Replace `@nylorun/harness/engine` imports with `@nylorun/harness/run`. Rename `runHosted` to `runDurable`, `createHostedCheckpoint` to `createDurableCheckpoint`, `HostedCheckpoint` / `HostedResult` to `DurableCheckpoint` / `DurableResult`, and `EngineHost` to `DurableHost`. Rename `EngineBinding`, `EngineRunOptions`, and `createEngineState` to `RunBinding`, `BoundRunOptions`, and `createRunState`. There are no compatibility aliases.

Durable execution reconstructs progress from a checkpoint and individually journaled effect outcomes; the host must persist both. Existing checkpoint fields and `ENGINE_VERSION = "hosted-1"` remain compatible.

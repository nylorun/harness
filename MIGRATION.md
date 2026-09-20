# Local Runtime beta migration

Upgrade the harness, SDK, Runtime, Studio, and creator as the tested compatible set in `create-agent/compatibility.json`. This migration changes public entry points and the session protocol.

1. Import `Agent` and `tool` from `@nylorun/agents`. Export `agents` from `agents/index.ts`. Keep model selection in Runtime configuration.
2. Remove the starter's Hono application and old `Runtime` / `serveAgents` / `openSession` imports. Definitions no longer expose `agent.run()`.
3. Use `nylorun configure`, then `nylorun dev`. Compiled `nylorun start` loads `dist/agents/index.js`. Runtime defaults to loopback port 8787.
4. Update custom applications to SDK `createClient` and session commands with stable idempotency keys. Trusted servers supply `ownerUserId`; input text uses `content`.
5. Custom connected executors use `connectAgents({ agents, runtime: { url, key } })`. Supply scoped executor credentials, separate from server credentials. The local CLI provisions these automatically.
6. Studio now uses canonical history and authenticated SSE through its local proxy. Attach with `nylorun studio --runtime-url http://127.0.0.1:8787`. Remove AG-UI and legacy manifest endpoint configuration.

Keep credentials and SQLite in gitignored `.nylorun/`; provider configuration uses `.env`. Keep backups of old SessionRecord/event files. They are not automatically converted to new SQLite checkpoints. Session export/import and migration tooling are deferred. Start new sessions after changing definitions or implementations.

Explicit in-process engine execution remains available to host authors through `@nylorun/harness/engine`; it is not loaded by the application SDK. OSS and Cloud consume the harness independently.

The release workflow covers local text and ordinary tools. Advanced examples remain source references outside the default registry. Media, approvals UI, subagents, deployment recipes, and broad recovery/conformance gates remain for later releases.

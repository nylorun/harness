# @nylorun/runtime

The independent OSS HTTP execution host consumes `@nylorun/harness/run` and `@nylorun/core/contracts`. Cloud consumes the harness independently. Client authoring, sessions and connected executors belong to `@nylorun/agents`.

Requires Node 24+. Build from the repository root:

```sh
npm install
npm run build --workspace @nylorun/core
npm run build --workspace @nylorun/harness
npm run build --workspace @nylorun/runtime
NYLORUN_SERVER_KEY='<separate-secret-at-least-16-characters>' npm start --workspace @nylorun/runtime
```

Default address: `http://127.0.0.1:8787`. `HOST`, `PORT`, and `NYLORUN_SQLITE_PATH` configure binding and storage. Missing server credentials fail startup. The default model is a credential-free scripted development response. It does not simulate conversations, tools or provider compatibility.

`NYLORUN_EXECUTORS_JSON` is an array of `{token, agentId, manifestHash, implementationVersion}`. Each secret must differ from the application server key and every other executor token. The manifest hash is available from `@nylorun/core/compatibility` or saved definition registration. SDK clients use `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, and `NYLORUN_EXECUTOR_KEY`; runtime executor scope is configured explicitly, never broadened by client input.

For a model gateway, set `NYLORUN_MODEL_GATEWAY_URL`, `NYLORUN_MODEL_GATEWAY_KEY`, and `NYLORUN_MODEL`. The gateway receives `{model, call, context}` and returns a harness ModelCandidate or string. Provider credentials remain host configuration. The generic gateway requires an implementation of this envelope; it does not claim arbitrary provider wire compatibility. Alternatively supply a `ModelProvider` to `startRuntime`.

```ts
import { startRuntime } from '@nylorun/runtime/core';
const runtime = await startRuntime({
  sqlitePath: './nylorun.sqlite',
  serverToken: process.env.NYLORUN_SERVER_KEY!,
  executors: [], // Configure exact scoped executor credentials before customer actions.
  port: 8787,
});
// Application owns lifecycle.
await runtime.close();
```

The session-first `/v1` API is specified in [HOST_CONTRACT.md](../harness/HOST_CONTRACT.md). `/health` confirms HTTP liveness; `/ready` checks SQLite and scheduler availability. Readiness is not a provider connectivity probe or functional correctness claim. Application tokens authorize definition/session APIs, while exact scoped executor credentials authorize authenticated SSE `/v1/executors/connect`, action discovery, claims, renewal and results. Session observers cannot claim actions.

SQLite transactions persist session checkpoints, command receipts, individual effects/actions, waits and canonical history. Actions are committed before notifications. Accepted execution is detached from HTTP request lifetime. Restart schedules persisted runnable sessions; model intents lacking recorded outcomes become uncertain. Expired customer claims become uncertain and are not automatically repeated. `GET /v1/sessions/:id` exposes waits, outstanding actions and uncertain effect summaries. Cancellation ends the current turn; a later message can start another turn from the state preceding the cancelled turn. Canonical events and uncertain external work remain inspectable. Reconciliation operations are not implemented in this pass.

One process owns each SQLite database. A local PID lock rejects concurrent owners and recovers only when the recorded process no longer exists. Shared/network filesystems and multiple replicas are unsupported. Keep the database and its WAL/journal together; do not delete persisted effects separately from checkpoints. Invalid lock contents or PID reuse fail closed and require operator inspection. TLS and external ingress belong to deployment infrastructure.

## Local project workflow

Install `@nylorun/cli` (generated projects already include it). Use `npm run configure`, then `nylorun dev` in a generated project. It loads the exported `agents` registry from `agents/index.ts`, starts this Runtime in a separate process, registers manifests, connects scoped SDK executors, and opens Studio. Use `--no-studio` or `--no-open` as needed. Runtime binds loopback on port 8787 (`PORT` override). The CLI creates separate server and executor credentials with mode 0600 in `.nylorun/local-credentials.json`; SQLite defaults to `.nylorun/runtime.sqlite`.

`nylorun start [entry]` loads `dist/agents/index.js` by default and runs without Studio/watch. `nylorun studio --runtime-url http://127.0.0.1:8787` attaches using the project's local server credential (or `NYLORUN_SERVER_KEY`). Provider selection uses the existing `MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY`, and optional `MODEL_PROVIDER_BASE_URL` configuration. No provider request occurs during configuration.

Definitions have no `agent.run()`; applications use `@nylorun/agents`. Remove old Hono `src/index.ts`, `Runtime`, `serveAgents`, and `openSession` usage from supported starters. Historical implementations remain internal for regression coverage and advanced examples; they are not root exports or supported hosting alternatives.

Source changes restart the local stack. Start a new session after definition or implementation edits; live upgrades are deferred. `GET /v1/agents` and `GET /v1/sessions?agentId=...` are server-authenticated local discovery conveniences. See the repository handoff for verification and remaining scope.

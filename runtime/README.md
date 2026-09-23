# @nylorun/runtime

The independent OSS HTTP execution host consumes `@nylorun/harness/run` and `@nylorun/core/contracts`. Cloud installs published `@nylorun/harness` from npm and does not import this Runtime package. Client authoring, sessions and connected executors belong to `@nylorun/agents`.

Requires Node 24+. Build from the repository root:

```sh
npm install
npm run build --workspace @nylorun/core
npm run build --workspace @nylorun/harness
npm run build --workspace @nylorun/runtime
NYLORUN_SERVER_KEY='<separate-secret-at-least-16-characters>' npm start --workspace @nylorun/runtime
```

Default address: `http://127.0.0.1:8787`. `HOST`, `PORT`, and `NYLORUN_SQLITE_PATH` configure binding and storage. Missing server credentials fail startup. The default model is a credential-free scripted development response. It does not simulate conversations, tools or provider compatibility.

`NYLORUN_EXECUTORS_JSON` is an array of `{token, agentId, implementationVersion}`. Each secret must differ from the application server key and every other executor token. An optional `manifestHash` on an existing record is ignored and does not hide or reject work. SDK clients use `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, and `NYLORUN_EXECUTOR_KEY`; runtime executor scope is the agent id, never broadened by client input.

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

The vault holds two scopes. End-user vaults each belong to one `ownerUserId` and store URL-bound credentials for outbound calls such as MCP. The host scope stores model provider credentials the Runtime uses when it calls a provider; Studio and `nylorun configure` can keep multiple providers and select the active provider/model. Secret values are encrypted with AES-256-GCM under a key-encryption key. Set `NYLORUN_VAULT_KEK` to 32 bytes encoded as base64, or allow the host to create `.nylorun/vault-kek` (mode 0600) on the first write. A database that already holds vault ciphertext will not open without that key. Reads return metadata only.

Agents that declare `.use(sandbox())` get Runtime-executed `bash`, `read`, `write`, `edit`, `grep` and `glob` tools. The Runtime owns each sandbox: one per session, created on the first sandbox tool call, stopped after its idle timeout, and reattached with its files on the next call, including after a restart. On first use the Runtime probes its backends in order and keeps the choice for its lifetime: a microsandbox microVM (macOS on Apple Silicon, or Linux with `/dev/kvm`), then the in-process virtual shell (`just-bash`). Set `NYLORUN_SANDBOX=microsandbox` or `virtual` to force one; a forced backend never falls back. `GET /v1/host/sandbox` reports the selection, and `nylorun doctor sandbox` shows the same probe. Virtual workspaces live in `sandboxes/` beside the SQLite file. Tool calls emit `sandbox.state` and `sandbox.exec` session events. A sandbox call interrupted by a crash becomes uncertain and is never re-run. `microsandbox` is an optional dependency pinned to an exact version. See [the sandbox design](../docs/design/sandboxes.md) for guarantees and limitations.

## Local project workflow

Install `@nylorun/cli` (generated projects already include it). Use `nylorun up` and `nylorun dev` in a generated project. It loads the exported `agents` registry from `agents/index.ts`, starts this Runtime in a separate process, and, when no host model credential is stored, prompts in an interactive terminal and writes it to the vault. It then registers manifests, connects scoped SDK executors, and opens Studio. Use `--no-studio` or `--no-open` as needed. Runtime binds loopback on port 8787 (`PORT` override). The CLI creates separate server and executor credentials with mode 0600 in `.nylorun/local-credentials.json`; SQLite defaults to `.nylorun/runtime.sqlite`.

`nylorun serve [entry]` loads `dist/agents/index.js` by default and runs without Studio/watch, attaching to the Runtime that `nylorun up` started. It uses the same first-start prompt. `nylorun configure` replaces the host credential against a Runtime that is already listening. `nylorun studio` attaches using the project's local server credential (or `NYLORUN_SERVER_KEY`). Studio can replace an API-key credential. If `MODEL_PROVIDER`, `MODEL`, and `MODEL_PROVIDER_API_KEY` are already set, the first start seeds the vault from them and does not prompt. Existing `.env` model settings and `.nylorun/auth.json` are imported once the same way. No provider request occurs during that setup. `NYLORUN_DEV_MODEL=fixture` and `NYLORUN_MODEL_GATEWAY_URL` remain separate from the vault.

Definitions have no `agent.run()`; applications use `@nylorun/agents`. Remove old Hono `src/index.ts`, `Runtime`, `serveAgents`, and `openSession` usage from supported starters. Historical implementations remain internal for regression coverage and advanced examples; they are not root exports or supported hosting alternatives.

Source changes restart the local stack. Start a new session after definition or implementation edits; live upgrades are deferred. `GET /v1/agents` and `GET /v1/sessions?agentId=...` are server-authenticated local discovery conveniences.

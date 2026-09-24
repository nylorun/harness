# @nylorun/runtime

> **DRAFT (WS-I Wave 1).** Describes the Runtime Host + Tenant model from Wave 0
> contracts. Finalize in Wave 3. Vocabulary: [src/CONTEXT.md](./src/CONTEXT.md).

The independent OSS **Runtime Host** consumes `@nylorun/harness/run` and
`@nylorun/core/contracts`. Cloud installs published `@nylorun/harness` from npm
and does not import this Runtime package. Client authoring, sessions and
connected executors belong to `@nylorun/agents`.

Requires Node 24+. Build from the repository root:

```sh
npm install
npm run build --workspace @nylorun/core
npm run build --workspace @nylorun/harness
npm run build --workspace @nylorun/runtime
```

Prefer starting the Host through the CLI (`nylorun runtime up`), which installs
a pinned `@nylorun/runtime` under the Host root and spawns
`@nylorun/runtime/server` with a baseline environment. Direct `npm start` for
embedding is still being reshaped; see [MIGRATION.md](../MIGRATION.md#runtime-tenants-breaking-beta).

Default address: loopback port `8787` (persisted in `host.json`). The Host root
is `NYLORUN_HOME` or `~/.nylorun`. Tenants live under `tenants/<tenantId>/`.

## Layout (draft)

```text
<host root>/
  host.json                 # hostId, bind address, port
  host-state.json           # pid, url — removed on shutdown
  host-credentials.json     # adminKey (0600)
  runtime.log
  runtime/<version>/        # verified install of this package
  tenants/<tenantId>/       # envelope, SQLite, KEK, logs, sandboxes, …
  trash/                    # deleted Tenants
```

## HTTP surface (draft)

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /health` | none | `hostId`, protocol `{min,max,features}`, `coreVersion`, pid — no `scopeId` |
| `GET /ready` | none | Listener up and Tenant discovery finished |
| `/v1/admin/*` | admin key | Create/list/status/delete Tenants; Host status; shutdown |
| `/v1/*` Tenant routes | application or executor | Require `Nylorun-Tenant` + `Nylorun-Protocol` |
| `GET /v1/tenant` | application | Tenant status (secrets redacted) |
| `/v1/tenant/model*` etc. | application | Renamed from `/v1/host/*` |

Missing or unsupported protocol → `426` before authentication. Unknown,
quarantined or rejected Tenant credentials → opaque `404` with identical body.

## Embedding and tests (draft)

`startRuntime` / `createRuntime` are removed. Tests and ephemeral embeds use
`startEphemeralRuntime()` from `@nylorun/runtime/core`: private Host on port 0,
temporary Host root, one Tenant, returns
`{ url, tenantId, applicationKey, adminKey, close() }`.

`NYLORUN_EXECUTORS_JSON` is removed. Register executors with
`PUT /v1/executors` using the application principal. Model gateway and sandbox
backend become Tenant configuration (vault / seed), not Host process env.

## Session behaviour (unchanged intent)

The session-first `/v1` API is specified in
[HOST_CONTRACT.md](../harness/HOST_CONTRACT.md) (Tenant header and `/v1/tenant/*`
renames are draft). Application tokens authorize definition/session APIs;
executor credentials authorize authenticated SSE connect, action discovery,
claims, renewal and results. Session observers cannot claim actions.

SQLite transactions persist session checkpoints, command receipts, individual
effects/actions, waits and canonical history — **per Tenant**. One process owns
each Tenant database (`.runtime-lock`). Keep the database and its WAL/journal
together. Vault ciphertext needs that Tenant's own KEK.

Agents that declare `.use(sandbox())` get Runtime-executed sandbox tools. The
Tenant owns each sandbox; backend names are prefixed `nylorun-<tenant-id>-`.
See [the sandbox design](../docs/design/sandboxes.md).

## Local Project workflow

Install `@nylorun/cli`. `nylorun runtime up` starts the Host; `nylorun dev`
creates or uses a Project link, seeds Tenant config, registers executors and
opens Studio. Project credentials live in `.nylorun/credentials.json` (0600)
with `link.json` — not beside an exclusive SQLite file for the whole Host.

## Troubleshooting (draft)

| Symptom | What to do |
| --- | --- |
| Tenant `locked` | Another process holds `.runtime-lock`; see `nylorun tenant status` repair string (`lockPid` / `lockPath`) |
| `kek-missing` | Restore the Tenant KEK beside the database; do not invent a new key if ciphertext exists |
| `schema-too-new` / `migration-failed` | Use a newer CLI Host, or restore from `.migration/…` per the quarantine `repair` |
| `426 protocol_unsupported` | Upgrade the CLI (`nylorun runtime restart`) or pin an older `@nylorun/cli` in range |
| Port in use | Explicit `--port` fails closed; first automatic setup may pick a free loopback port and persist it |
| Logs | `nylorun runtime logs [--follow]` multiplexes `runtime.log` and each `tenants/*/logs/tenant.log` |

Definitions have no `agent.run()`; applications use `@nylorun/agents`.

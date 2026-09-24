# @nylorun/runtime

The independent OSS **Runtime Host** consumes `@nylorun/harness/run` and
`@nylorun/core/contracts`. Cloud installs published `@nylorun/harness` from npm
and does not import this Runtime package. Client authoring, sessions and
connected executors belong to `@nylorun/agents`. Vocabulary:
[src/CONTEXT.md](./src/CONTEXT.md).

Requires Node 24+. Build from the repository root:

```sh
npm install
npm run build --workspace @nylorun/core
npm run build --workspace @nylorun/harness
npm run build --workspace @nylorun/runtime
```

Prefer starting the Host through the CLI (`nylorun runtime up`), which installs
a pinned `@nylorun/runtime` under the Host root and spawns
`@nylorun/runtime/server` with a baseline environment. For tests and ephemeral
embeds, use `startEphemeralRuntime()` from `@nylorun/runtime/core`. See
[MIGRATION.md](../MIGRATION.md#runtime-tenants-breaking-beta).

Default address: loopback port `8787` (persisted in `host.json`). The Host root
is `NYLORUN_HOME` or `~/.nylorun`. Tenants live under `tenants/<tenantId>/`.

## Layout

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

## HTTP surface

| Route                    | Auth                    | Notes                                                                                     |
| ------------------------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| `GET /health`            | none                    | `service: "nylorun-runtime"`, `hostId`, protocol `{min,max,features}`, `coreVersion`, pid |
| `GET /ready`             | none                    | Listener up and Tenant discovery finished                                                 |
| `/v1/admin/*`            | admin key               | Create/list/status/delete Tenants; Host status; shutdown                                  |
| `/v1/*` Tenant routes    | application or executor | Require `Nylorun-Tenant` + `Nylorun-Protocol`                                             |
| `GET /v1/tenant`         | application             | Tenant status (secrets redacted)                                                          |
| `/v1/tenant/model*` etc. | application             | Tenant model, selection, providers, models, sandbox                                       |

Missing or unsupported protocol → `426` before authentication. Unknown,
quarantined or rejected Tenant credentials → opaque `404` with identical body.

## Embedding and tests

Tests and ephemeral embeds use `startEphemeralRuntime()` from
`@nylorun/runtime/core`: private Host on port 0, temporary Host root, one Tenant,
returns `{ url, tenantId, applicationKey, adminKey, close() }`.

Register executors with `PUT /v1/executors` using the application principal.
Model gateway and sandbox backend are Tenant configuration (vault / seed), not
Host process env.

## Session behaviour

The session-first `/v1` API is specified in
[HOST_CONTRACT.md](../harness/HOST_CONTRACT.md). Application tokens authorize
definition/session APIs; executor credentials authorize authenticated SSE
connect, action discovery, claims, renewal and results. Session observers cannot
claim actions.

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

```sh
eval "$(npx nylorun runtime status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

## Troubleshooting

| Symptom                        | What to do                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant `locked`                | Another process holds `.runtime-lock`. `nylorun tenant status` prints `repair` with `lockPid` / `lockPath` — stop that pid or remove a stale lock                   |
| `kek-missing`                  | Restore the Tenant KEK beside the database; do not invent a new key if ciphertext exists                                                                            |
| `corrupt`                      | Repair or restore the Tenant directory from backup (`nylorun tenant status` repair string)                                                                          |
| `schema-too-new`               | Upgrade the Host: `nylorun runtime restart` from a newer CLI                                                                                                        |
| `migration-failed`             | Restore the path under `.migration/…` named in `repair`, then `nylorun tenant status`                                                                               |
| `envelope-invalid`             | Fix or replace `tenant.json` so its id matches the directory name                                                                                                   |
| `open-timeout` / `open-failed` | Inspect locks, SQLite and Tenant logs; repair before the Host retries open                                                                                          |
| `426 protocol_unsupported`     | Client protocol or features are outside the Host range. Upgrade the Host (`nylorun runtime restart`) or install a matching older `@nylorun/cli` / `@nylorun/agents` |
| Port in use                    | Explicit `--port` fails closed (exit 4). First automatic Host setup may pick a free loopback port, persist it in `host.json`, and print the chosen URL              |
| Logs                           | `nylorun runtime logs [--follow]` multiplexes `runtime.log` and each `tenants/*/logs/tenant.log`                                                                    |

Definitions have no `agent.run()`; applications use `@nylorun/agents`.

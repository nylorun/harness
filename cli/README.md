# @nylorun/cli

The local `nylorun` executable. Requires Node 24+. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

```sh
nylorun runtime up                 # start the Runtime Host (detached)
nylorun runtime down               # stop the Host; keep Tenants and host.json
nylorun runtime status             # Host id, address, protocol, Tenant list
nylorun runtime status --env       # export lines for the linked Project
nylorun runtime logs [--follow]    # Host + Tenant logs
nylorun runtime restart            # install CLI's exact runtime, then restart
nylorun runtime run                # attached foreground Host
nylorun dev                        # link/create Tenant, watch agents, Studio
nylorun dev --ephemeral            # private temp Host + one Tenant
nylorun serve [entry]              # compiled build (default dist/agents/index.js)
nylorun configure                  # replace model credential on the linked Tenant
nylorun studio
nylorun tenant current|list|use|status|reset|delete
nylorun doctor sandbox             # which sandbox backend this machine offers
```

## The Runtime Host is a separate, persistent process

`nylorun runtime up` installs a verified `@nylorun/runtime` under the Host root
and starts `@nylorun/runtime/server` in the background. `dev` and `serve` attach
to it: they create or reuse a **Project link**, register agents, and connect
executors through `PUT /v1/executors`. They start the Host when nothing is
listening, and leave it running on exit. Pass `--no-autostart` to fail instead
(CI). `runtime run` keeps the Host attached for logs.

## Host root, Tenants and Project link

The **Host root** is `NYLORUN_HOME` or `~/.nylorun` (resolved absolute once).
It holds `host.json`, admin credentials, installed runtimes and every Tenant.
Isolation is per **Tenant**, not per Project directory.

A **Project** stores only:

- `.nylorun/link.json` — `{ hostUrl, hostId, tenantId }`
- `.nylorun/credentials.json` — application key, principal id, executor tokens (0600)
- `.nylorun/.gitignore` containing `*`

First `dev` without a link creates a Tenant (id and secrets generated locally;
only hashes are sent), writes link + credentials after success, and prints a
banner with Host address and Tenant name/id.

```sh
eval "$(npx nylorun runtime status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

Port defaults to `8787` on loopback. On first automatic Host setup, if that port
is taken, the CLI picks a free loopback port, persists it in `host.json`, and
prints the URL. Explicit `--port` is strict (exit 4 on collision).

## Exit codes

| Code      | Meaning                                            |
| --------- | -------------------------------------------------- |
| 0         | Success, including `down` when nothing was running |
| 1         | Generic failure                                    |
| 2         | Usage error                                        |
| 3         | `runtime status` or `logs`: not running            |
| 4         | Port held by another process                       |
| 5         | Protocol / feature incompatible with this CLI      |
| 6         | `--no-autostart` and nothing is listening          |
| 7         | The Host did not become ready                      |
| 130 / 143 | SIGINT / SIGTERM                                   |

`dev` loads `agents/index.ts` using project-installed `tsx` and watches changes.
Studio and `tsx` are optional development dependencies; the CLI is a production
dependency when the application's `start` script uses it.

## Troubleshooting

| Symptom                | What to do                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| Quarantined Tenant     | `nylorun tenant status` shows reason and `repair`                       |
| `426` / exit 5         | `nylorun runtime restart` from a newer CLI, or pin a matching older CLI |
| Port conflict (exit 4) | Stop the other process or `nylorun runtime up --port <n>`               |
| Logs                   | `nylorun runtime logs --follow`                                         |

See [package architecture](../docs/design/package-architecture.md) and
[MIGRATION.md](../MIGRATION.md#runtime-tenants-breaking-beta).

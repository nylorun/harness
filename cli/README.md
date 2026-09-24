# @nylorun/cli

> **DRAFT (WS-I Wave 1).** Host lifecycle (Wave 1) and Project link / `tenant`
> commands (Wave 2) are described from the Runtime Tenants plan. Finalize in
> Wave 3. Vocabulary: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

The local `nylorun` executable. Requires Node 24+.

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
There is no project/global "scope": isolation is per **Tenant**.

A **Project** stores only:

- `.nylorun/link.json` — `{ hostUrl, hostId, tenantId }`
- `.nylorun/credentials.json` — application key, principal id, executor tokens (0600)
- `.nylorun/.gitignore` containing `*`

First `dev` without a link creates a Tenant (id and secrets generated locally;
only hashes are sent), writes link + credentials after success, and prints a
banner with Host address and Tenant name/id.

```sh
# After a Project is linked (Wave 2):
eval "$(npx nylorun runtime status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

`--global`, `--db`, and `NYLORUN_SQLITE_PATH` are removed. Port defaults to
`8787` on loopback (or a free port persisted on first automatic setup);
`--port` is strict.

## Exit codes (draft)

| Code | Meaning |
| --- | --- |
| 0 | Success, including `down` when nothing was running |
| 1 | Generic failure |
| 2 | Usage error |
| 3 | `runtime status` or `logs`: not running |
| 4 | Port held by another process |
| 5 | Protocol / feature incompatible with this CLI |
| 6 | `--no-autostart` and nothing is listening |
| 7 | The Host did not become ready |
| 130 / 143 | SIGINT / SIGTERM |

`dev` loads `agents/index.ts` using project-installed `tsx` and watches changes.
Studio and `tsx` are optional development dependencies; the CLI is a production
dependency when the application's `start` script uses it.

See [package architecture](../docs/design/package-architecture.md) and
[MIGRATION.md](../MIGRATION.md#runtime-tenants-breaking-beta).

# @nylorun/cli

The local `nylorun` executable. Depends on `@nylorun/agents` and `@nylorun/admin`
only among Nylorun packages — it runs the **launcher** inside a Runtime build as
a process and never imports `@nylorun/runtime`. Requires Node 24+. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

```sh
nylorun runtime up                 # launcher: install pin if needed, start Host
nylorun runtime down               # stop the Host; keep Tenants and host.json
nylorun runtime status             # Host id, address, version, Tenant list
nylorun runtime status --env       # export lines for the linked Project
nylorun runtime logs [--follow]    # Host + Tenant logs
nylorun runtime restart            # restart onto the CLI's pinned Runtime build
nylorun runtime run                # attached foreground Host
nylorun dev [entry]                # up → link/create Tenant → tsx watch entry
nylorun dev --ephemeral            # temporary Host root + one Tenant
nylorun configure                  # replace model credential on the linked Tenant
nylorun tenant list|delete|status|reset
nylorun doctor sandbox             # sandbox backend via Tenant API
```

Removed in this release: `nylorun serve`, `nylorun studio` (use `nylorun-studio`),
and the in-process Project runner. Production `start` is
`node dist/src/main.js` with `connectAgents` in the application.

## Runtime builds and the launcher

`nylorun runtime …` resolves the newest installed Runtime build under the Host
root, bootstraps from the registry when none exists, and invokes
`nylorun-runtime` with `--json`. The Host runs on the build's bundled Node.
See [building a desktop client](../docs/building-a-desktop-client.md) for the
launcher contract.

`dev` starts (or reuses) the Host via the launcher, creates a Tenant through
`@nylorun/admin` when the Project has no link, writes format-1 link +
credentials, and spawns `tsx watch <entry>` with
`NYLORUN_RUNTIME_URL`, `NYLORUN_TENANT` and `NYLORUN_SERVER_KEY`. The ready
banner hints `Studio: npm run studio`. Ctrl-C stops the child; the Host stays up.

## Host root, Tenants and Project link

The **Host root** is `NYLORUN_HOME` or `~/.nylorun` (resolved absolute once).
It holds `host.json`, admin credentials, installed Runtime builds and every
Tenant. Isolation is per **Tenant**, not per Project directory.

A **Project** stores only:

- `.nylorun/link.json` — `{ format, hostUrl, hostId, tenantId }`
- `.nylorun/credentials.json` — application key and principal id (0600); no
  executor tokens
- `.nylorun/.gitignore` containing `*`

```sh
eval "$(npx nylorun runtime status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

Port defaults to `8787` on loopback. On first Host setup, if that port is
taken, the launcher picks a free loopback port and persists it. Explicit
`--port` is strict.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, including `down` when nothing was running |
| 1 | Generic failure / launcher operation failed |
| 2 | Usage error |
| 3 | `runtime status` or `logs`: not running |
| 4 | Port held by another process |
| 5 | Protocol / feature incompatible with this CLI |
| 7 | The Host did not become ready |
| 130 / 143 | SIGINT / SIGTERM |

Install the CLI as a **devDependency**. Generated applications keep
`@nylorun/agents` alone in production dependencies.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Quarantined Tenant | `nylorun tenant status` shows reason and `repair` |
| `426` / exit 5 | Upgrade CLI / Runtime pin, or pin a matching older set |
| Port conflict | Stop the other process or `nylorun runtime up --port <n>` |
| Logs | `nylorun runtime logs --follow` |
| No Runtime build | First `runtime up` / `dev` bootstraps; needs network once |

See [package architecture](../docs/design/package-architecture.md) and
[MIGRATION.md](../MIGRATION.md#runtime-clients-and-admin-api-breaking-beta).

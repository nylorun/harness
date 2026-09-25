# @nylorun/cli

The local `nylorun` executable. Depends on `@nylorun/agents` and `@nylorun/admin`
only among Nylorun packages — it runs the installed Runtime's **launcher** as a
process and never imports `@nylorun/runtime`. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

Prerequisites, installed by the developer (the CLI never downloads them):

```sh
node --version                            # 24 or newer
npm install --global @nylorun/runtime     # provides nylorun-runtime
nylorun doctor runtime                    # checks both
```

```sh
nylorun runtime up                 # launcher: start the Host
nylorun runtime down               # stop the Host; keep Tenants and host.json
nylorun runtime status             # Host id, address, version, Tenant list
nylorun runtime status --env       # export lines for the linked Project
nylorun runtime logs [--follow]    # Host + Tenant logs
nylorun runtime restart            # restart onto the installed Runtime
nylorun runtime run                # attached foreground Host
nylorun dev [entry]                # up → link/create Tenant → tsx watch entry
nylorun dev --ephemeral            # temporary Host root + one Tenant
nylorun dev --local-ui             # also start Studio with a local dashboard
nylorun studio [--local-ui]        # start Studio (launch URL + proxy token)
nylorun configure                  # replace model credential on the linked Tenant
nylorun tenant list|delete|status|reset
nylorun doctor runtime             # prerequisites: Node 24+, installed Runtime
nylorun doctor sandbox             # sandbox backend via Tenant API
```

`nylorun serve` remains removed. Production `start` is
`node dist/src/main.js` with `connectAgents` in the application.
`--local-ui` cannot be combined with `--no-studio`.

## The launcher

`nylorun runtime …` finds `nylorun-runtime` on PATH, checks that it speaks
launcher protocol 1 and a compatible Host protocol, and invokes it with
`--json`. The Host runs on the same Node, from the installed
`@nylorun/runtime`. When the launcher is missing or incompatible, the command
exits 1 with the install command for the recommended version
(`cli/package.json` `nylorun.runtime`). A project devDependency on
`@nylorun/runtime` also works, because npm scripts put `node_modules/.bin` on
PATH. See [building a desktop client](../docs/building-a-desktop-client.md)
for the launcher contract.

`dev` starts (or reuses) the Host via the launcher, creates a Tenant through
`@nylorun/admin` when the Project has no link, writes format-1 link +
credentials, and spawns `tsx watch <entry>` with
`NYLORUN_RUNTIME_URL`, `NYLORUN_TENANT` and `NYLORUN_SERVER_KEY`. The ready
banner hints `Studio: npm run studio`, or prints the Studio `launchUrl` when
started with `--local-ui`. Ctrl-C stops the child; the Host stays up.
`nylorun studio` resolves `@nylorun/studio`, supplies `cacheDir` from the Host
root (`NYLORUN_HOME` / `~/.nylorun`, never cwd), and prints `launchUrl`.

## Host root, Tenants and Project link

The **Host root** is `NYLORUN_HOME` or `~/.nylorun` (resolved absolute once).
It holds `host.json`, admin credentials and every Tenant; the Runtime itself
is installed by npm. Isolation is per **Tenant**, not per Project directory.

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
| Runtime not installed | `npm install --global @nylorun/runtime`; `nylorun doctor runtime` checks |

See [package architecture](../docs/design/package-architecture.md) and
[MIGRATION.md](../MIGRATION.md#runtime-clients-and-admin-api-breaking-beta).

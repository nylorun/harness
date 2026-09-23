# @nylorun/cli

The local `nylorun` executable. Requires Node 24+.

```sh
nylorun up                  # start the local Runtime (alias for "nylorun runtime start")
nylorun dev                 # watch agents/index.ts, open Studio
nylorun dev --no-studio
nylorun serve [entry]       # run the compiled build, default dist/agents/index.js
nylorun configure
nylorun studio
nylorun runtime status
nylorun down                # stop the Runtime, keeping SQLite and credentials
```

## The Runtime is a separate, persistent process

`nylorun up` starts `@nylorun/runtime/server` in the background and returns the
terminal. `dev` and `serve` attach to it, registering the project's exported
agents and connecting scoped executors through `PUT /v1/executors`. They start
the Runtime themselves when nothing is listening, and they leave it running on
exit, so a watch restart re-registers agents without losing sessions. Pass
`--no-autostart` to fail instead, which is what CI should do. `--foreground`
keeps `runtime start` attached for logs.

## Scope

A project is the default scope: the Runtime's SQLite, credentials, log and pid
live in `.nylorun/` beside the nearest `package.json`, created on first use and
added to an existing `.gitignore`. `--global` (and running outside a project)
uses `~/.nylorun` instead, relocatable with `NYLORUN_HOME`. Both default to
`127.0.0.1:8787`; `--port` beats `NYLORUN_PORT`, then `PORT`, then the port
recorded for a running Runtime. `--db` or `NYLORUN_SQLITE_PATH` moves the
database. `nylorun runtime status --output json` prints the resolved scope for
scripts, and `nylorun logs [-f]` tails the Runtime's own output.

Runtime and executor credentials remain separate. On first `configure`, `dev` or
`serve`, an interactive terminal saves the model provider credential into the
Runtime vault; `configure` replaces it while the Runtime is already running.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, including `down` when nothing was running |
| 1 | Generic failure |
| 2 | Usage error |
| 3 | `runtime status` or `logs`: not running |
| 4 | Port held by another process or another scope |
| 5 | The running Runtime does not match this CLI |
| 6 | `--no-autostart` and nothing is listening |
| 7 | The Runtime did not become healthy |
| 130 / 143 | SIGINT / SIGTERM |

`dev` loads `agents/index.ts` using project-installed `tsx` and watches changes.
Studio and `tsx` are optional development dependencies; the CLI is a production
dependency when the application's `start` script uses it.

Reusable provider configuration is imported from `@nylorun/runtime/configuration`;
interactive prompts and process supervision belong here. Neither runtime nor
harness depends on this package. See [package architecture](../docs/design/package-architecture.md).

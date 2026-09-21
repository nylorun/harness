# @nylorun/cli

The local `nylorun` executable. Requires Node 24+.

```sh
nylorun configure
nylorun dev
nylorun dev --no-studio
nylorun start
nylorun studio --runtime-url http://127.0.0.1:8787
```

The CLI launches `@nylorun/runtime/server` in a child process, registers the
project's exported agents with the SDK, connects scoped customer executors and
optionally opens a project-installed `@nylorun/studio`. Runtime and executor
credentials remain separate. Configuration lives in the existing project files;
the SQLite database defaults to `.nylorun/runtime.sqlite`.

`dev` loads `agents/index.ts` using project-installed `tsx` and watches changes.
`start [entry]` defaults to `dist/agents/index.js` without Studio or watching.
Studio and `tsx` are optional development dependencies; the CLI is a production
dependency when the application's `start` script uses it.

Reusable provider configuration is imported from `@nylorun/runtime/configuration`;
interactive prompts and process supervision belong here. Neither runtime nor
harness depends on this package. See [package architecture](../docs/design/package-architecture.md).

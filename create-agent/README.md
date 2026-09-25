# @nylorun/create-agent

Install the prerequisites first (the creator checks them and never installs
them). On Windows, work inside [WSL2](https://learn.microsoft.com/windows/wsl/install); native Windows is not
supported.

```sh
node --version                                 # 24 or newer
npm install --global @nylorun/runtime@beta     # provides nylorun-runtime
npm create @nylorun/agent@beta my-agent
```

Creates a Node 24 project with `@nylorun/agents` and Zod in production, plus
`@nylorun/cli` and optional Studio as development tools. The registry in
`agents/index.ts` exports agent definitions. `src/main.ts` calls
`connectAgents` for both `npm run dev` and `npm start`. The starter includes
one ordinary `lookup_order` tool; ask “Look up order demo-123”.

Creation installs dependencies and starts development. If a prerequisite is
missing, it stops after creating the project and prints what to install. Use `-- --no-studio` to
omit Studio from the project, or `-- --no-open` to suppress browser opening.
`--yes` affects installation only. The first `nylorun dev` starts the local
Runtime and asks for the model provider when the terminal is interactive and
stores the credential in the Runtime vault. A non-interactive start without a
credential exits and names that setup. `NYLORUN_DEV_MODEL=fixture` skips it.

```sh
cd my-agent
npm run dev
npm run studio
npm run build
npm start
```

`npm run studio` runs `nylorun-studio` and can start before or after `dev`.
`npm start` runs `node dist/src/main.js` with the same entry as development.
Export the Project environment (`eval "$(npx nylorun runtime status --env)"`)
before a production start when there is no Project link. Studio can replace an
API-key credential. `nylorun configure` replaces the credential against an
already running Runtime. Local Runtime credentials, the vault, and SQLite are
stored in gitignored `.nylorun/`. Definitions have no model provider or
`agent.run()`.

`starter/` is the canonical template. `compatibility.json` pins core, harness,
agents, admin, Runtime, Studio and CLI. The examples recipe adds local package
dependencies. Run `npm run examples:sync` after template changes, then
`npm install --prefix examples`. Sync preserves authored agents, tests,
credentials, and local state; it rejects conflicting edits to generated files.

The default examples registry contains the release starter. Advanced examples
remain outside that registry for later migration.

After building, `node create-agent/scripts/smoke-starter.mjs` installs packed
packages outside the workspace and checks the actual Studio/tool workflow,
history, reload, source restart, compiled start, headless mode, and shutdown.
It uses a deterministic fixture without live provider calls. Browser checks
require Chrome (or `NYLORUN_CHROME_PATH`).

See [RELEASING](../RELEASING.md) for the Changesets beta workflow. Nothing is
published by the smoke check.

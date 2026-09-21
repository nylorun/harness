# @nylorun/create-agent

```sh
npm create @nylorun/agent@beta my-agent
```

Creates a Node 24 project with `@nylorun/agents`, `@nylorun/cli`, Zod, and optional Studio. The registry in `agents/index.ts` exports agent definitions. The starter includes one ordinary `lookup_order` tool; ask “Look up order demo-123”.

Creation installs dependencies, runs provider configuration, and starts development. Use `-- --no-studio` for headless development or `-- --no-open` to suppress browser opening. Noninteractive creation requires `-- --skip-config`; configure the retained project before running it. Without provider settings startup reports `nylorun configure`. `--yes` affects installation only.

```sh
cd my-agent
npm run configure
npm run dev
npm run build
npm start
```

Development restarts the Runtime and connected executor on source changes. Compiled start uses `dist/agents/index.js` and runs headless. Studio can attach separately. Local Runtime credentials and SQLite are stored in gitignored `.nylorun/`. Model selection remains Runtime configuration in `.env`; definitions have no model provider or `agent.run()`.

`starter/` is the canonical template. `compatibility.json` pins core, harness, SDK, Runtime, Studio and CLI. The examples recipe adds local package dependencies. Run `npm run examples:sync` after template changes, then `npm install --prefix examples`. Sync preserves authored agents, tests, credentials, and local state; it rejects conflicting edits to generated files.

The default examples registry contains the release starter. Advanced examples remain outside that registry for later migration.

After building, `node create-agent/scripts/smoke-starter.mjs` installs packed packages outside the workspace and checks the actual Studio/tool workflow, history, reload, source restart, compiled start, headless mode, and shutdown. It uses a deterministic fixture without live provider calls. Browser checks require Chrome (or `NYLORUN_CHROME_PATH`).

See [RELEASING](../RELEASING.md) for the Changesets beta workflow. Nothing is published by the smoke check.

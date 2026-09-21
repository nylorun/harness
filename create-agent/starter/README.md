# My Nylorun agent

Requires Node 24 and npm 11. Agent and tool definitions live in `agents/`. The CLI runs a separate SQLite Runtime and connects your tools through the SDK's authenticated SSE executor.

```sh
npm run configure
npm run dev
```

Open Studio and ask **Look up order demo-123**. The local tool returns `shipped`; Studio shows the tool call and assistant response. Model calls use your configured provider and may incur its usual charges.

`npm run dev -- --no-open` avoids opening a browser. `--no-studio` runs headless. Use `npm run studio` to attach separately. Runtime defaults to `http://127.0.0.1:8787`; `PORT` changes it. Studio chooses a free port starting at 4161.

```sh
npm run build
npm start
```

Compiled start runs Runtime and executor without Studio or watching. Studio can attach in a separate terminal. `agents/index.ts` exports the registry; there is no Hono app to maintain. Source edits restart the local development stack. Start a new session after changing definitions or implementations; active-session upgrades are not supported.

Local credentials and SQLite live in gitignored `.nylorun/`. Keep this directory private. Credentials are generated automatically and kept out of browser configuration. Ordinary shutdown/restart preserves completed session history. `NYLORUN_IMPLEMENTATION_VERSION` defaults to `dev`; assign an explicit version when changing a versioned implementation.

This beta supports local text and ordinary tools. Advanced waits, media, MCP, subagents, deployment, reconciliation and broad recovery guarantees are deferred. `NYLORUN_DEV_MODEL=fixture` is a credential-free release-check fixture for this starter; it is not a general model.

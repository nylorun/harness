# My Nylorun agent

Requires Node 24 and npm 11. Agent and tool definitions live in `agents/`. A separate SQLite Runtime holds your sessions; this project attaches to it and connects your tools through the SDK's authenticated SSE executor.

```sh
npm run dev
```

The first run starts the Runtime for you and asks for a model provider, storing the credential in the Runtime vault. **The Runtime keeps running after you stop `dev`, so sessions survive a source change.** `npx nylorun down` stops it; `npx nylorun runtime status` shows where it is. Later runs reuse it. Open Studio and ask **Look up order demo-123**. The local tool returns `shipped`; Studio shows the tool call and assistant response. Model calls use the Runtime's saved provider and may incur its usual charges. Studio's Model provider screen can replace an API key. `npx nylorun configure` does the same from a terminal while the Runtime is running.

`npm run dev -- --no-open` avoids opening a browser. `--no-studio` runs headless. `--no-autostart` fails instead of starting a Runtime, which is what CI wants. Use `npm run studio` to attach separately. Runtime defaults to `http://127.0.0.1:8787`; `--port` or `PORT` changes it. Studio chooses a free port starting at 4161.

```sh
npm run build
npm start
```

`npm start` runs `nylorun serve`, which attaches the compiled build without Studio or watching, starting the Runtime first if none is up. Studio can attach in a separate terminal. `agents/index.ts` exports the registry; there is no Hono app to maintain. A source edit re-registers agents and reconnects executors; the Runtime process is untouched. Start a new session after changing definitions or implementations; active-session upgrades are not supported.

Local Runtime credentials, the model provider vault, SQLite, and the Runtime log live in gitignored `.nylorun/` beside this project. Each project gets its own Runtime; `nylorun up --global` shares one in `~/.nylorun` instead. Keep this directory private. Server and executor credentials are generated automatically. The model provider key is encrypted in the vault and kept out of browser configuration and `.env`. Ordinary shutdown/restart preserves completed session history. `NYLORUN_IMPLEMENTATION_VERSION` defaults to `dev`; assign an explicit version when changing a versioned implementation.

This beta supports local text and ordinary tools. Advanced waits, media, MCP, deployment, reconciliation and broad recovery guarantees are deferred. Subagents are supported in the SDK and examples (`agents used as tools`); the starter itself does not wire them. `NYLORUN_DEV_MODEL=fixture` is a credential-free release-check fixture for this starter; it is not a general model.

# My Nylorun agent

> **DRAFT (WS-I Wave 1).** Project link + Tenant wording. Finalize in Wave 3.

Requires Node 24 and npm 11. Agent and tool definitions live in `agents/`. A
**Runtime Host** holds your sessions in isolated **Tenants**; this project
attaches through a **Project link** and connects your tools through the SDK's
authenticated SSE executor.

```sh
npm run dev
```

The first run starts (or attaches to) the Runtime Host, creates a Tenant,
writes `.nylorun/link.json` and `.nylorun/credentials.json`, and asks for a
model provider (stored in that Tenant's vault). **The Host keeps running after
you stop `dev`, so sessions survive a source change.** `npx nylorun runtime down`
stops it; `npx nylorun runtime status` shows Host and Tenants. Later runs reuse
the link. Open Studio and ask **Look up order demo-123**. The local tool returns
`shipped`; Studio shows the tool call and assistant response. Model calls use
the Tenant's saved provider and may incur its usual charges. Studio's Model
provider screen can replace an API key. `npx nylorun configure` does the same
from a terminal while the Host is running.

`npm run dev -- --no-open` avoids opening a browser. `--no-studio` runs
headless. `--no-autostart` fails instead of starting a Host, which is what CI
wants. `npm run dev -- --ephemeral` uses a private temporary Host and one Tenant
(removed on clean exit). Use `npm run studio` to attach separately. Host
defaults to loopback port `8787`; `--port` changes it when starting. Studio
chooses a free port starting at 4161.

```sh
npm run build
npm start
```

`npm start` runs `nylorun serve`, which attaches the compiled build without
Studio or watching, starting the Host first if none is up. Studio can attach in
a separate terminal. `agents/index.ts` exports the registry; there is no Hono
app to maintain. A source edit re-registers agents and reconnects executors; the
Host process is untouched. Start a new session after changing definitions or
implementations; active-session upgrades are not supported.

Export the linked Project environment:

```sh
eval "$(npx nylorun runtime status --env)"
```

Project link and credentials live in gitignored `.nylorun/` beside this project.
The Host root (`NYLORUN_HOME` or `~/.nylorun`) holds every Tenant. A fresh clone
or second worktree does not reuse this link until you create or choose one.
Keep `.nylorun/` private. Application and executor credentials are generated
automatically. The model provider key is encrypted in the Tenant vault and kept
out of browser configuration and `.env`. Ordinary shutdown/restart preserves
completed session history. `NYLORUN_IMPLEMENTATION_VERSION` defaults to `dev`;
assign an explicit version when changing a versioned implementation.

This beta supports local text and ordinary tools. Advanced waits, media, MCP,
deployment, reconciliation and broad recovery guarantees are deferred.
Subagents are supported in the SDK and examples (`agents used as tools`); the
starter itself does not wire them. `NYLORUN_DEV_MODEL=fixture` is a
credential-free release-check fixture for this starter; it is not a general
model.

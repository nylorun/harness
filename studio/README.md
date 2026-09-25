# @nylorun/studio

Local session dashboard for one **Tenant**, with a **hosted** UI by default
(`https://local.nylorun.studio`) paired to a loopback trusted proxy. Independent
development tool: depends only on `@nylorun/agents` among Nylorun packages.
Requires Node 24+. Vocabulary: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

```sh
npm run studio          # → nylorun-studio (hosted UI + local proxy)
nylorun studio --local-ui   # Safari / offline / distrust live origin
nylorun-studio          # --port <n>  --no-open  --local-ui
```

## Hosted vs local UI

| Mode | How | Dashboard origin |
| --- | --- | --- |
| **Hosted** (default) | `nylorun studio` / `nylorun dev` | `https://local.nylorun.studio` with `#port` + `#token` fragment |
| **Local** | `--local-ui` | Proxy serves a digest-pinned bundle from `dist/web` or cache |

The proxy always binds loopback, mints a per-launch bearer token, and holds the
Runtime server key and Tenant. The browser never receives Runtime credentials.
Only `https://local.nylorun.studio` (or the proxy’s own origin in local mode)
may call `/_studio/*`.

Safari blocks HTTPS→HTTP loopback: use `--local-ui`. If the hosted origin is
unreachable, the CLI prints the same tip next to the launch URL.

## Connection

Studio resolves the connection with `resolveConnection()` from `@nylorun/agents`
(Project link or environment). Executor role is rejected. Until a connection
resolves and `/health` answers, it prints `Waiting for nylorun dev…` once and
retries every 2 s — so `npm run studio` works before or after `npm run dev`.

Studio never creates Tenants, writes `.nylorun/`, calls the Admin API or starts
the Host. It is read-only against an existing linked Project.

Studio lists registered agents and sessions, sends text, displays completed
assistant responses and tool inputs/results, restores history, observes
canonical SSE events, and cancels a turn. Each session shows chat beside an
**Events** inspector and an optional Agent Manifest tab. **Vault** and **Model
Settings** use the Tenant API through the agents SDK. Responses appear when
complete; token streaming, media, approvals UI, and remote deployment are
deferred.

Programmatic hosts use
`startStudio({ runtimeUrl, serverKey, tenant: { id, name }, open: false })`
(default `ui: "hosted"`) and await the returned handle’s `close()`. Pass
`ui: "local"` and `cacheDir` for local mode. `startStudio()` remains exported.

For repository development and publication, see [CONTRIBUTING](../CONTRIBUTING.md)
and [RELEASING](../RELEASING.md).

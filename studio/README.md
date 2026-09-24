# @nylorun/studio

Local session dashboard for one **Tenant**. Independent development tool:
depends only on `@nylorun/agents` among Nylorun packages. Requires Node 24+.
Vocabulary: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

```sh
npm run studio          # → nylorun-studio
nylorun-studio          # --port <n>  --no-open
```

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

The local Node host proxies a small allowlist of Runtime HTTP/SSE routes
(including `/v1/tenant/*`). It holds the application credential, stamps
`Nylorun-Tenant` and `Nylorun-Protocol`, and excludes executor claims/results.
The browser never receives Runtime or executor credentials. Studio binds
loopback and accepts only a loopback Runtime destination. Upstream proxy
requests carry no `Origin` header.

Programmatic hosts use
`startStudio({ runtimeUrl, serverKey, tenant: { id, name }, open: false })` and
await the returned handle's `close()`. `startStudio()` remains exported.

For repository development and publication, see [CONTRIBUTING](../CONTRIBUTING.md)
and [RELEASING](../RELEASING.md).

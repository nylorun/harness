# @nylorun/studio

Local session dashboard for the OSS Runtime. Requires Node 24.

The starter's `npm run dev` starts Studio automatically. To attach to an already running local project, use `npm run studio`, or `nylorun studio --runtime-url http://127.0.0.1:8787`.

Studio lists registered agents and sessions, sends text, displays completed assistant responses and tool inputs/results, restores history, observes canonical SSE events, and cancels a turn. Responses appear when complete; token streaming, media, approvals UI, and remote deployment are deferred.

The local Node host proxies a small allowlist of Runtime HTTP/SSE routes. It holds the server credential, stamps local ownership, and excludes executor claims/results. The browser never receives Runtime or executor credentials. Studio binds loopback and accepts only a loopback Runtime destination.

Programmatic hosts use `startStudio({ runtimeUrl, serverKey, open: false })` and await the returned handle's `close()`. Studio uses the SDK; its browser bundle contains no harness engine. The CLI belongs to `@nylorun/runtime`.

For repository development and publication, see [CONTRIBUTING](../CONTRIBUTING.md) and [RELEASING](../RELEASING.md).

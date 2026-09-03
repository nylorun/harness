# `@nylorun/studio`

Studio is a loopback-only dashboard for developer-owned agent servers. It serves static UI assets;
it does not load agent code, proxy provider requests, or receive browser credentials.

```sh
npx @nylorun/studio@beta studio --agent-server-url http://127.0.0.1:4111
```

The agent server must allow Studio's loopback origin with CORS and expose:

| Endpoint                               | Purpose                                  |
| -------------------------------------- | ---------------------------------------- |
| `GET /v1/agents`                       | Agent IDs and manifest URLs              |
| `GET /agents/:id/manifest.json`        | One non-secret agent manifest            |
| `POST /agents/:id/v1/ag-ui`            | AG-UI SSE run stream                     |
| `GET/POST /agents/:id/v1/sessions/...` | Sessions, events, history, and approvals |

An examples-server manifest may additionally expose a non-secret `mediaInput` capability with
`acceptedTypes` and `maxBytes`. Studio uses it to enable a single image attachment in the chat
composer and sends that attachment as AG-UI native image content. This is an optional examples
extension, not a required Studio or Harness server API.

The dependency-free discovery and manifest types are exported from this package. Do not put keys,
cookies, headers, or provider payloads in Studio configuration, manifests, or events.

See [Examples](../examples/README.md) for a direct-Harness Hono implementation.

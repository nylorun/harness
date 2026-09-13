# Deploying an application

Publishing the four npm packages is covered in [RELEASING.md](./RELEASING.md).
This guide describes an application created with `@nylorun/create-agent`.
There is no hosting-provider deployment workflow in this repository.

## Build and run

From the application directory:

```sh
npm ci
npm run build
npm ci --omit=dev
npm run start
```

Build before omitting development dependencies. Keep these in the deployment:

| Item | Purpose |
|---|---|
| `dist/` | Built Hono app, agent graph, and application assets |
| `package.json`, `package-lock.json` | Reproducible production dependencies |
| Provider environment variables | Model selection, API keys, and integration settings |
| Persistent `.data/` volume, when configured | Session history and media |

Provision credentials through the hosting environment's secret facilities;
never bake them into source control or a public image. Set `MODEL_PROVIDER`,
`MODEL`, and `MODEL_PROVIDER_API_KEY`; custom OpenAI-compatible providers also
require `MODEL_PROVIDER_BASE_URL`. Provider-native API-key variables remain
supported. `nylorun start` optionally loads a local `.env` file without overriding
process variables. OAuth state, when used, lives in `.nylorun/auth.json`.

Studio is a development dependency and is attached separately with `npm run studio`.
External integrations may require additional runtimes, executables, or network
access. Use `projectAsset()` for catalogs and bundled subprocess assets so they
resolve from the built application.

## Hosting requirements and current limits

- The CLI Node launcher listens on **all interfaces, port 3000** by
  default. Your Hono application owns public binds, CORS, trusted-host handling,
  reverse-proxy policy, authentication, and authorization; set `PORT`
  deliberately for deployments. The template does not set `HOST`.
- An ingress proxy must support long-lived streaming responses without buffering
  and use suitable idle timeouts. Supply TLS and access controls at the hosting
  boundary; this repository does not configure them.
- Keep `.data/` on durable storage when using local adapters. JSONL history
  survives restart, but archived sessions cannot resume execution.
- Process lifecycle is the application's job; the generated entrypoint does not
  register signal handlers. Graceful shutdown is optional: handlers may await
  `runtime.close()` to stop live sessions, flush pending journal writes, and run
  optional agent cleanup. Without handlers, restart ends live sessions. JSONL
  history survives only to the last durable write.
- Local JSONL/media adapters are filesystem-based. Do not assume shared mutable
  state works across replicas; choose storage adapters before scaling out.

Choose the hosting target before adding deployment automation, public binding,
health/readiness integration, or replica coordination.

The starter exports its Hono app without opening a socket on import. This convention does not imply verified serverless session persistence or Workers compatibility; provider validation is separate work.

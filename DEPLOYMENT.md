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
| `dist/` | Built configuration, agent graph, and application assets |
| `package.json`, `package-lock.json` | Reproducible production dependencies |
| `config/model.json` | Selected provider/model |
| Private `.env/` configuration | Provider credentials and integration settings |
| Persistent `.data/` volume, when configured | Session history and media |

Provision credentials through the hosting environment's secret facilities;
never bake them into source control or a public image. Current Runtime reads
provider credentials from `.env/auth.json` and optional integration variables
from `.env/integrations.env`, relative to the application working directory.

Studio is a development dependency and is not started by `nylorun start`.
External integrations may require additional runtimes, executables, or network
access. Use `projectAsset()` for catalogs and bundled subprocess assets so they
resolve from the built application.

## Hosting requirements and current limits

- Runtime binds to **127.0.0.1** and serves only its own loopback Host headers
  unless told otherwise. Behind a same-host reverse proxy, list the public names
  in `ALLOWED_HOSTS` (for example `agent.example.com`). For container port
  publishing, set `HOST=0.0.0.0`; a published bind serves every Host header
  unless `ALLOWED_HOSTS` narrows it. `PORT` chooses the port in both cases.
- An ingress proxy must support long-lived streaming responses without buffering
  and use suitable idle timeouts. Supply TLS and access controls at the hosting
  boundary; this repository does not configure them.
- Keep `.data/` on durable storage when using local adapters. JSONL history
  survives restart, but archived sessions cannot resume execution.
- Deliver SIGTERM during shutdown and allow cleanup time. Restart ends active
  sessions and pending interactions. Choose deployment/restart policy accordingly.
- Local JSONL/media adapters are filesystem-based. Do not assume shared mutable
  state works across replicas; choose storage adapters before scaling out.

Choose the hosting target before adding deployment automation, public binding,
health/readiness integration, or replica coordination.

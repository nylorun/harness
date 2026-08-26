# Nylo Agents

Open-source TypeScript authoring, build and run tooling for Nylo agents.

This repository contains five independently versioned packages:

- [`@nylorun/agent`](./agent) — the executable-free adapter contract shared by hosts and harnesses.
- [`@nylorun/harness`](./harness) — Nylo's native configurable agent loop.
- [`@nylorun/runtime`](./runtime) — the production-safe host layer: authoring types, structural validation, typed tools, the Vite build, local records and REST/SSE door, and publishing.
- [`@nylorun/studio`](./studio) — the optional developer-only `nylo` command, loopback Studio host, and local browser workspace.
- [`@nylorun/create-agent`](./create-agent) — the generator invoked by `npm create @nylorun/agent@latest`.

**A generated project installs runtime and `@nylorun/harness`**, Nylo's native loop, then passes a
deferred Harness factory to `Run((model, directive) => Agent(model, directive), runOptions)`. Runtime owns the host and
supplies model, tool, and observation bindings before it builds the Harness. Use `nylo adapter
probe` to inspect the bound Harness declaration without starting a Session.

## Quick start

```sh
npm create @nylorun/agent@latest my-agent -- --model anthropic/example
cd my-agent
cp .env.example .env
npm run dev
```

Create a session with `POST /v1/sessions` using `{ "agent_id": "<agent>", "message": "…" }`, then follow it with `GET /v1/sessions/<id>/stream`. The same session accepts later `{ "message": "…" }` posts and exposes both bounded event pages and resumable SSE.
`nylo dev`, `nylo serve`, and `nylo studio` are supplied by the developer-only Studio package; model access remains outbound runtime
composition through `ModelGatewayAdapter` or standard local resolution.

Public npm publication is intentionally deferred until a release candidate is approved. Development
and integration use `npm pack` tarballs in the meantime; the manual, environment-protected staging
workflow cannot run without an explicit maintainer confirmation.

## Development

The six packages form one npm workspace. The executable-free contract is shared by runtime and every
harness; a packaged clean-project test is required because unpublished dependencies do not resolve
from the registry.

```sh
npm ci
npm run check      # build, test, generated-reference and tarball gates
```

Per package:

```sh
npm run check --workspace @nylorun/agent
npm run check --workspace @nylorun/harness
npm run check --workspace @nylorun/runtime
npm run check --workspace @nylorun/studio
npm run check --workspace @nylorun/create-agent
```

## License

Apache-2.0.

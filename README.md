# Nylo Agents

Nylo's agent-authoring packages. Harness is prepared for a separate public source repository; Create Agent and Studio are distributed as npm packages while their source remains in this repository.

This repository contains three independently versioned packages:

- [`@nylorun/harness`](./harness) — Nylo's native configurable agent loop.
- [`@nylorun/create-agent`](./create-agent) — the public generator and the source of the generated project-local development contract.
- [`@nylorun/studio`](./studio) — the optional developer-only `nylo` command, loopback Studio host, and local browser workspace.

**A generated project has one Nylo production dependency: `@nylorun/harness`.** It keeps Create Agent, Studio, TypeScript, and Vite in development dependencies. Create Agent writes `nylo.local.ts` at the project root; that file is the stable local contract Studio uses to check, build, watch, serve, and observe the project. It is copied into the project rather than supplied by a Runtime package.

## Quick start

```sh
npm create @nylorun/create-agent@latest my-agent -- --model anthropic/example
cd my-agent
cp .env.example .env
npm run dev
```

Create a session with `POST /v1/sessions` using `{ "agent_id": "<agent>", "message": "…" }`, then follow it with `GET /v1/sessions/<id>/stream`. The same session accepts later `{ "message": "…" }` posts and exposes both bounded event pages and resumable SSE.

`nylo dev`, `nylo serve`, and `nylo studio` are supplied by the developer-only Studio package. The generated helper resolves OpenAI-compatible and localhost-model providers from environment variables, keeps credentials out of records and diagnostics, and exposes only loopback local hosting.

## Development

The three packages form one npm workspace. A packed clean-project test is required because the local development contract must work when installed only from package artifacts.

```sh
npm ci
npm run check
```

Per package:

```sh
npm run check --workspace @nylorun/harness
npm run check --workspace @nylorun/create-agent
npm run check --workspace @nylorun/studio
```

## Licenses

Harness is Apache-2.0. Create Agent and Studio are proprietary packages; see their package licenses.

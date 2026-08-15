# Nylo Agents

Open-source TypeScript authoring and build tooling for Nylo agents.

This repository contains two independently versioned packages:

- [`@nylorun/agents`](./agents) — authoring types, structural validation, typed tools, the Vite build integration, and the session loop that runs the result.
- [`@nylorun/create-agent`](./create-agent) — the generator invoked by `npm create @nylorun/agent@latest`.

## Quick start

```sh
npm create @nylorun/agent@latest my-agent -- --model anthropic/example
cd my-agent
echo "OPENROUTER_API_KEY=sk-or-..." > .env
npm run dev -- "What can you do?"
```

The session loop that answers is the same one the hosted runtime uses — one implementation, two callers. Deployment is a separate future capability.

Public npm publication is intentionally deferred until a release candidate is approved. Development and integration use `npm pack` tarballs in the meantime; the manual, environment-protected staging workflow cannot run without an explicit maintainer confirmation.

## Development

Each package is standalone and owns its dependencies and lockfile.

```sh
npm ci --prefix agents
npm run check --prefix agents

npm ci --prefix create-agent
npm run check --prefix create-agent
```

## License

Apache-2.0.

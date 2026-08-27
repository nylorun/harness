# `@nylorun/create-agent`

Create a buildable Nylo Harness agent project:

```sh
npm create @nylorun/create-agent@latest my-agent -- --model anthropic/example
cd my-agent
npm run build
```

The generator writes an ordinary TypeScript and Vite project. Its only Nylo production dependency is `@nylorun/harness`; Create Agent and Studio are pinned development dependencies.

Every project also receives a root `nylo.local.ts`. This is the stable project-local contract used by Studio: it exposes the agent authoring helpers plus hooks to validate, build, watch, serve REST/SSE/AG-UI, persist local records, and cancel sessions. It supports environment-driven OpenAI-compatible providers and localhost models, and never writes provider credentials to diagnostics or records.

Run local development with `npm run dev` or `npm run dev -- --studio`. The latter opens the loopback-only Studio host and pairs its exact origin through CORS. The generator does not install a global CLI.

Direct package-runner forms are also supported:

```sh
npx @nylorun/create-agent@latest my-agent --model anthropic/example --yes
pnpm dlx @nylorun/create-agent@latest my-agent --model anthropic/example --yes
yarn dlx @nylorun/create-agent@latest my-agent --model anthropic/example --yes
bunx @nylorun/create-agent@latest my-agent --model anthropic/example --yes
```

The interface is `create-agent [directory] [--name <slug>] [--model <creator/model>] [--yes]`. It refuses a non-empty target and keeps the generated files with an exact recovery command if dependency installation fails.

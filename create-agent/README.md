# `@nylorun/create-agent`

Create a buildable Nylo agent project:

```sh
npm create @nylorun/agent@latest my-agent -- --model anthropic/example
cd my-agent
npm run build
```

The generator writes an ordinary TypeScript and Vite project. It does not install a persistent Nylo CLI.

Direct package-runner forms are also supported:

```sh
npx @nylorun/create-agent@latest my-agent --model anthropic/example --yes
pnpm dlx @nylorun/create-agent@latest my-agent --model anthropic/example --yes
yarn dlx @nylorun/create-agent@latest my-agent --model anthropic/example --yes
bunx @nylorun/create-agent@latest my-agent --model anthropic/example --yes
```

The interface is `create-agent [directory] [--name <slug>] [--model <creator/model>] [--yes]`. It refuses a non-empty target and keeps the generated files with an exact recovery command if dependency installation fails.

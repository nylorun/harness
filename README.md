# Nylorun Harness

Nylorun Harness is a provider-neutral TypeScript agent loop with direct capability composition.
This repository contains independent Harness, Runtime, Studio, and creator packages, plus runnable examples.

> **Experimental beta.** APIs may change before 1.0.

## Packages

- [`@nylorun/harness`](./harness) — model/tool loop and capability composition.
- [`@nylorun/runtime`](./runtime) — agent lifecycle, Hono protocol routing, pi-ai providers, and the `nylorun` CLI.
- [`@nylorun/studio`](./studio) — local dashboard for compatible agent servers.
- [`@nylorun/create-agent`](./create-agent) — project creation, compatibility pins, and examples synchronization.
- [`examples`](./examples) — eleven authored capability demonstrations on the generated project shell.

## Develop

Use Node 24 and npm 11; see [contributor setup](./CONTRIBUTING.md).

```sh
git clone https://github.com/nylorun/harness.git
cd harness
npm run setup
npm run dev
```

## Create an agent

Create a local TypeScript agent project with Studio enabled by default:

```sh
npm create @nylorun/agent@beta my-agent
```

The generated project directly installs Harness and Runtime, with Studio as a development dependency. Creation installs dependencies, opens provider/model configuration in the same terminal, then starts development. Pass `-- --skip-config` to configure later; this flag is required without interactive stdin and stdout. Use `-- --no-studio` to create a headless project. Runtime supplies the `nylorun` CLI; the creator is used only to scaffold the project.

See the [Harness package](./harness/README.md), [Runtime](./runtime/README.md), [Studio](./studio/README.md), and
[Examples](./examples/README.md).
Contributor commands: [CONTRIBUTING.md](./CONTRIBUTING.md). Administrators: [RELEASING.md](./RELEASING.md). Application hosting: [DEPLOYMENT.md](./DEPLOYMENT.md). Security reports
follow [SECURITY.md](./SECURITY.md).

Licensed under [Apache-2.0](./LICENSE).

Run `npm run check:stack` for isolated packed-project CLI, Studio, reload, and built-asset integration checks.

# Nylorun Harness

Observable, portable, composable TypeScript agent execution. Harness is state-in/state-out; optional Runtime owns sessions and hosting.

This repository contains `@nylorun/harness` (shared definitions/contracts/engine), `@nylorun/agents` (the application SDK and SSE executor), and `@nylorun/runtime` (the independent OSS SQLite host), alongside Studio and the project creator. Cloud lives in the private agents-api repository and consumes the harness directly.

For the new core-runtime beta, start with [the SDK](agents/README.md), [standalone Runtime](runtime/README.md), [host contract](harness/HOST_CONTRACT.md), and [implementation handoff](IMPLEMENTATION_HANDOFF.md). The local starter/Studio workflow uses this architecture. The packed-package text/tool workflow is covered by the focused release smoke; broader recovery and conformance gates remain open.

> **Experimental beta.** Public APIs may change before 1.0. Prefer the `@beta` dist-tag for installs until then.

## Quick start

Create a local agent project (Studio enabled by default):

```sh
npm create @nylorun/agent@beta my-agent
```

Then follow the terminal prompts to configure a model provider and start development.

Useful flags (after `--`):

| Flag | Effect |
|---|---|
| `--skip-config` | Skip provider setup (required when stdin/stdout are not interactive) |
| `--no-studio` | Scaffold a headless project without Studio |

The creator scaffolds, installs, configures, and starts the project. The generated app depends on the SDK and Runtime; Studio is a development dependency. Runtime provides the `nylorun` CLI.

## Develop this repository

Requires **Node 24** and **npm 11**. See [CONTRIBUTING.md](./CONTRIBUTING.md).

```sh
git clone https://github.com/nylorun/harness.git
cd harness
npm run setup
npm run dev
```

`npm run setup` installs both lockfiles and builds packages. Before starting the examples app, run `npm run configure`.

## Packages

| Package | Role |
|---|---|
| [`@nylorun/harness`](./harness) | Shared definitions, contracts, engine and compatibility |
| [`@nylorun/agents`](./agents) | Session SDK, authoring and authenticated SSE customer executor |
| [`@nylorun/runtime`](./runtime) | SQLite execution host, providers, and the `nylorun` CLI |
| [`@nylorun/studio`](./studio) | Local dashboard for compatible agent servers |
| [`@nylorun/create-agent`](./create-agent) | Project scaffolding, compatibility pins, and examples sync |
| [`examples`](./examples) | Authored capability demonstrations on the generated project shell |

## Documentation

| Doc | Audience |
|---|---|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contributors — setup, checks, workflow |
| [RELEASING.md](./RELEASING.md) | Maintainers — version, publish, dist-tags |
| [MIGRATION.md](./MIGRATION.md) | Breaking beta migration |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Application hosting |
| [SECURITY.md](./SECURITY.md) | Vulnerability reports |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | Community standards |

Package-level READMEs: [Harness](./harness/README.md) · [Runtime](./runtime/README.md) · [Studio](./studio/README.md) · [Examples](./examples/README.md)

## License

[Apache-2.0](./LICENSE)

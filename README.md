# Nylorun Harness

Provider-neutral TypeScript agent runtime with direct capability composition.

This repository is a monorepo of independently versioned packages—Harness, Runtime, Studio, and the project creator—plus runnable examples.

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

The creator only scaffolds the project. The generated app depends on Harness and Runtime; Studio is a development dependency. Runtime provides the `nylorun` CLI.

## Develop this repository

Requires **Node 24** and **npm 11**. See [CONTRIBUTING.md](./CONTRIBUTING.md).

```sh
git clone https://github.com/nylorun/harness.git
cd harness
npm run setup
npm run dev
```

`npm run setup` installs both lockfiles and builds packages. Before the first conversation in the examples app, run `npm run configure` in another terminal.

## Packages

| Package | Role |
|---|---|
| [`@nylorun/harness`](./harness) | Model/tool loop and capability composition |
| [`@nylorun/runtime`](./runtime) | Agent lifecycle, Hono protocol routing, providers, and the `nylorun` CLI |
| [`@nylorun/studio`](./studio) | Local dashboard for compatible agent servers |
| [`@nylorun/create-agent`](./create-agent) | Project scaffolding, compatibility pins, and examples sync |
| [`examples`](./examples) | Authored capability demonstrations on the generated project shell |

## Documentation

| Doc | Audience |
|---|---|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contributors — setup, checks, workflow |
| [RELEASING.md](./RELEASING.md) | Maintainers — version, publish, dist-tags |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Application hosting |
| [SECURITY.md](./SECURITY.md) | Vulnerability reports |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | Community standards |

Package-level READMEs: [Harness](./harness/README.md) · [Runtime](./runtime/README.md) · [Studio](./studio/README.md) · [Examples](./examples/README.md)

## License

[Apache-2.0](./LICENSE)

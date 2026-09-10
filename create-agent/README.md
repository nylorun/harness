# @nylorun/create-agent

```sh
npm create @nylorun/agent@beta my-agent
```

Creates a project that directly installs Harness and Runtime, with Studio as a development dependency. The project owns its ordinary `agent/` code and composes the packages in `nylorun.config.ts`. No server or provider implementation is copied into the project.

Creation installs dependencies, runs Runtime’s provider/model configuration wizard in the same terminal, then starts development. Pass `-- --no-studio` for a headless project or `-- --no-open` to suppress the browser. `nylorun configure` connects a provider without importing the agent graph.

## Configuration and recovery

Use `-- --skip-config` to start development without configuring a provider:

```sh
npm create @nylorun/agent@beta my-agent -- --skip-config
```

Without interactive stdin and stdout, creation requires `--skip-config` and fails
before creating files when it is missing. `--yes` only affects installation; it
does not skip configuration. After skipping, run `npm run configure` inside the
project in another terminal before sending a message. Development and Studio
start immediately; provider configuration takes effect without restarting them.

If configuration fails or is cancelled, development does not start and the
created project is retained. Resume from its directory:

```sh
cd my-agent
npm run configure
npm run dev
```

If installation failed, run `npm install` first. Ctrl-C exits with status 130;
SIGTERM exits with status 143. Cancelling setup also cancels pending authentication.
Configuration saves the provider selection and credentials; it does not make a
model request to validate connectivity.

## Maintaining examples

`starter/` is the canonical project template. `compatibility.json` pins tested Harness, Runtime, and Studio versions. `examples.recipe.json` explicitly adds the eleven-agent registry, local package references, persistence/media configuration, and test dependencies.

From the repository root:

```sh
npm run examples:sync
npm install --prefix examples
npm run examples:check
```

The renderer is shared by project creation, the isolated starter development runner, and examples synchronization. Sync owns shell files listed in `examples/.scaffold-manifest.json`; it never edits `agent/`, tests, local model selection, credentials, or `.data/`. Edit generated configuration in the recipe or template. Conflicts with manual generated-file edits fail before any writes. CI checks the rendered shell and runs examples against the current stack. Package changes can require explicit adaptations in authored code; sync does not rewrite TypeScript imports.

`npm run dev:starter` from the repository root previews a fresh project using local packages, including unpublished changes. Each preview has its own retained directory and provider configuration.

Repository development: [contributing](../CONTRIBUTING.md). Package publication: [releasing](../RELEASING.md).

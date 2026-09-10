# Contributing

## Repository map

| Directory | Responsibility |
|---|---|
| `harness/` | Agent engine and capabilities |
| `runtime/` | Providers, hosting, persistence, and `nylorun` |
| `studio/` | Dashboard and programmatic startup |
| `create-agent/` | Starter, renderer, compatibility pins, and stack tests |
| `examples/` | Generated application shell and authored demonstrations |
| `scripts/` | Repository development, validation, and release tooling |

Harness and Runtime must not depend on each other. Studio depends on neither.
Cross-package contracts are tested in the creator. Examples remains a separate
npm project with its own lockfile.

## First run

Use **Node 24 and npm 11** (CI pins 24.15.0 and 11.15.0; matching majors is enough). With nvm:

```sh
nvm install
nvm use
npm install --global npm@11.15.0
npm run setup
npm run dev
```

Setup installs both lockfiles and builds packages. All four packages compile with the TypeScript 7 native compiler; `typescript` is aliased to the TypeScript 6 bridge for scripts that use the compiler API. It does not configure models,
regenerate examples, or change local credentials/data. Package consumer Node
support remains separate from the pinned contributor toolchain.

Studio opens at `http://127.0.0.1:4161`; Runtime listens on port 4111.
Opening Studio needs no credentials. Before your first conversation, run this
in another terminal:

```sh
npm run configure
```

Provider setup belongs to examples. Credentials live in `examples/.env/`, model
selection in `examples/config/`, and persistence/media in `examples/.data/`.
Live integrations may need additional setup; see [examples](./examples/README.md).

## Development

| Command | Use |
|---|---|
| `npm run dev` | Examples with live package rebuilds and Studio hot reload |
| `npm run dev -- --no-open` | Keep the browser closed |
| `npm run dev -- --no-studio` | Run only the agent server |
| `npm run dev -- --port 4200 --studio-port 4201` | Choose different ports |
| `npm run dev:starter` | Preview a fresh starter against local packages |
| `npm run build` | Build all four packages |
| `npm test` | Run package, tooling, and examples tests after setup |
| `npm run check` | Build and run the standard repository checks |
| `npm run check:stack` | Test isolated tarballs, CLI commands, and built assets |

Agent/configuration edits use Runtime reload and retain existing sessions.
Harness/Runtime edits rebuild and restart the server: **active sessions end**.
A compile error leaves the running server available; fixing it resumes rebuilds.
Studio frontend edits hot reload; server edits rebuild and restart Studio.
Stop development before changing dependencies, then rerun setup.

Starter preview prints a retained directory under `.tmp/` and its provider setup
command. It has its own configuration. Rerun to preview template changes; existing
preview agents and credentials are never overwritten.

For focused checks: `npm run check --workspace @nylorun/runtime` (substitute another
package). CI uses `-- --built` on root checks after setup to avoid rebuilding.

## Generated examples and dependencies

Edit starter files or the examples recipe, then:

```sh
npm run examples:sync
npm install --prefix examples
npm run examples:check
```

Review the generated diff and lockfile. Never hand-edit files owned by
`examples/.scaffold-manifest.json`. Agent demonstrations, tests, scripts, and local
state are authored or local; synchronization does not overwrite them.
Use `npm install` explicitly when changing dependencies, committing the affected
lockfile. Routine setup uses `npm ci` and never refreshes lockfiles.

## Pull requests

Keep changes focused and test observable behavior. For a package release, add a
short change description with `npm run changeset`; select the affected packages
and version impact. Repository-only changes do not require package releases.
Run `npm run check`; run `npm run check:stack` for packaging or cross-package changes.
See [RELEASING.md](./RELEASING.md) for administrators and
[DEPLOYMENT.md](./DEPLOYMENT.md) for application hosting.

| Problem | Action |
|---|---|
| Toolchain mismatch | Use Node 24 and npm 11; setup prints the detected versions |
| Missing/stale package build | Stop development and run `npm run setup` |
| Occupied port | Stop the other service or choose root development ports |
| Model setup error | Run `npm run configure`; check integration-specific setup |
| Generated-file conflict | Move the intended change into the template/recipe, then sync |
| Interrupted release preparation | Inspect the diff; do not blindly rerun or discard it |

Contributions are licensed under [Apache-2.0](./LICENSE); no CLA is required.
Report vulnerabilities through [SECURITY.md](./SECURITY.md), not public issues.

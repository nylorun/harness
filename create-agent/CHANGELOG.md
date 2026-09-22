# Changelog

## 0.7.1-beta

### Patch Changes

- Update the tested Harness, SDK, Runtime, and Studio compatibility combination.

## 0.7.0-beta

### Minor Changes

- c0e74f1: Migrate the creator to the SDK registry, separate local Runtime and connected executor. Replace the Hono app template with a text-and-tool starter and canonical session Studio.
- 41e613c: Ship the local SDK registry workflow with an independent SQLite Runtime, connected tool executor, authenticated Studio proxy, and a text-and-tool starter. Replace the legacy Hono starter and AG-UI transport. Require Node 24 and include the SDK in exact release compatibility pins.

  Break the Harness execution import from `/engine` to `/run` and rename hosted execution APIs to durable execution APIs, including RunBinding, BoundRunOptions, and createRunState. Update all consumers without compatibility aliases; retain persisted checkpoint fields and version pins.

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.

### Patch Changes

- Update the tested Harness, SDK, Runtime, and Studio compatibility combination.

## 0.6.0-beta

### Minor Changes

- c5bbb1a: Breaking beta: make Harness `run()` a direct async state-in/state-out executor with
  serializable pauses, application `info`, cancellation signals, awaited recording, and
  agent-level output schemas. Runtime owns session scheduling with memory-default or exclusive
  local storage and imports Harness contracts. Isolate Node adapters under `runtime/node`, stream
  observations incrementally, and add opt-in bounded token previews with Studio reconciliation.
  Migrate consumers and deployment guidance together; legacy event records remain archived, not
  automatically replayed. Starter docs cover memory-default sessions and opt-in
  `localSessions` from `@nylorun/runtime/node`. Studio tests cover capability-manifest discovery
  with legacy `middleware` fallback.

### Patch Changes

- Update the tested Harness, Runtime, and Studio compatibility combination.

## 0.5.0-beta

### Minor Changes

- fa1860a: Use standard MODEL_PROVIDER, MODEL, MODEL_PROVIDER_API_KEY, and MODEL_PROVIDER_BASE_URL environment configuration. Export starter Hono apps and provide CLI development and production Node launchers. Existing starters require manual migration. Release preparation must update the creator Runtime compatibility pin with this release.

### Patch Changes

- Update the tested Harness, Runtime, and Studio compatibility combination.

## 0.4.0-beta

### Minor Changes

- 9c350be: Provide `nylorun dev` with optional Studio and browser opening, automatic development loopback CORS, and inferred Hono mount paths. Move local model selection to `.env/model.json` with legacy fallback and migration. Generate starters without copied launcher scripts, a top-level config directory, or a separate TypeScript build config. Release preparation must update the creator's Runtime compatibility pin together with these changes.

### Patch Changes

- Update the tested Harness, Runtime, and Studio compatibility combination.

## 0.3.1-beta

### Patch Changes

- fd24b00: Flatten Runtime agent routes to `/:id/...` and pass matching `basePath` from the Hono mount so discovery, manifests, and AG-UI resolve at `/agents/:id/...` for Studio.
- Update the tested Harness, Runtime, and Studio compatibility combination.

## 0.3.0-beta

### Minor Changes

- 4badb5b: Move model execution to session startup, provide Runtime as a mountable Hono router, and generate Hono-first projects with supervised application and Studio development. Studio now resolves root-relative Runtime endpoints correctly for custom mount paths.

### Patch Changes

- Update the tested Harness, Runtime, and Studio compatibility combination.

## 0.2.1-beta

### Patch Changes

- Update the tested Harness, Runtime, and Studio compatibility combination.

## 0.2.0-beta

### Minor Changes

- 54ab304: Configure the provider and model after project installation and before development
  starts. Add --skip-config for deferred setup and require it for noninteractive
  creation. Retain the project with recovery instructions when setup fails or is
  cancelled, and cancel pending prompts, authentication, and child processes on
  shutdown.

### Patch Changes

- 54ab304: Group generated npm scripts by workflow and remove the redundant `dev:host` alias.
  Use `npm run dev -- --no-studio` for headless development.
- 54ab304: Support portable Runtime protocol version 2 while retaining legacy Studio
  manifest support. Move the Studio CLI into Runtime: use `nylorun studio
--agent-url <url>` instead of `nylo studio`. Applications should install Runtime
  directly and keep Studio as a development dependency.

  Retain session lists and media across development reloads, and recognize agent
  file changes on Windows. Validate noninteractive creator startup during release
  verification with deferred provider configuration.

  Include Harness in this release so the creator does not rely on an unpublished
  compatibility pin. Ship and verify all four packages together.

- Update the tested Harness, Runtime, and Studio compatibility combination.

Release notes are maintained with Changesets.

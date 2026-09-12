# Changelog

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

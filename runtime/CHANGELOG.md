# Changelog

## 0.5.0-beta

### Minor Changes

- Breaking beta: Runtime hosts use Harness `info` (`getInfo` / `SubmitOptions.info`) instead of
  `scope`. Session scheduling stays in Runtime; Node-only adapters remain under
  `@nylorun/runtime/node`. Compatible with Harness capability manifests and ToolDescriptor-only
  model requests.
- c5bbb1a: Breaking beta: make Harness `run()` a direct async state-in/state-out executor with
  serializable pauses, application `info`, cancellation signals, awaited recording, and
  agent-level output schemas. Runtime owns session scheduling with memory-default or exclusive
  local storage and imports Harness contracts. Isolate Node adapters under `runtime/node`, stream
  observations incrementally, and add opt-in bounded token previews with Studio reconciliation.
  Migrate consumers and deployment guidance together; legacy event records remain archived, not
  automatically replayed.

### Patch Changes

- Add a proposed Cloud Agents API destination client (`AgentsApiClient` + cloud
  `openSession` routing via `NYLORUN_MODE=cloud` / `RuntimeConfig.cloud`) with
  mock HTTP/SSE contract tests. Maps Runtime `info` to wire `user` at the HTTP
  edge; surfaces `session_busy` without steering. Local destination unchanged.
  Wire contracts remain proposed until phase-0 freeze — no live Cloud E2E.
- Ignore Hono Node `context.env` stream bindings (`incoming`/`outgoing`) when
  resolving model environment so Node `nylorun dev` uses process `.env` /
  `piModel` instead of an empty portable HTTP adapter.
- Update Runtime's canonical Harness dependency to the tested release.
- Updated dependencies [c5bbb1a]
  - @nylorun/harness@0.13.0-beta

## 0.4.0-beta

### Minor Changes

- fa1860a: Use standard MODEL_PROVIDER, MODEL, MODEL_PROVIDER_API_KEY, and MODEL_PROVIDER_BASE_URL environment configuration. Export starter Hono apps and provide CLI development and production Node launchers. Existing starters require manual migration. Release preparation must update the creator Runtime compatibility pin with this release.

## 0.3.0-beta

### Minor Changes

- 9c350be: Provide `nylorun dev` with optional Studio and browser opening, automatic development loopback CORS, and inferred Hono mount paths. Move local model selection to `.env/model.json` with legacy fallback and migration. Generate starters without copied launcher scripts, a top-level config directory, or a separate TypeScript build config. Release preparation must update the creator's Runtime compatibility pin together with these changes.

## 0.2.1-beta

### Patch Changes

- fd24b00: Flatten Runtime agent routes to `/:id/...` and pass matching `basePath` from the Hono mount so discovery, manifests, and AG-UI resolve at `/agents/:id/...` for Studio.

## 0.2.0-beta

### Minor Changes

- 4badb5b: Move model execution to session startup, provide Runtime as a mountable Hono router, and generate Hono-first projects with supervised application and Studio development. Studio now resolves root-relative Runtime endpoints correctly for custom mount paths.

## 0.1.2-beta

### Patch Changes

- d27242c: Show stopped guardrail and failed model requests as errors in Studio. Runtime now emits a terminal AG-UI error instead of marking failed requests successful, and Studio displays the reported message. The guardrails example also checks text content parts sent by Studio, including mixed media input, before invoking the model.
- d27242c: Preserve opaque provider continuation metadata through assistant conversation history. Gemini tool calls now retain thought signatures when sending tool results back to the model, including signed empty text and reasoning blocks. Only the originating provider and model receive their signatures.

## 0.1.1-beta

### Patch Changes

- 54ab304: Configure the provider and model after project installation and before development
  starts. Add --skip-config for deferred setup and require it for noninteractive
  creation. Retain the project with recovery instructions when setup fails or is
  cancelled, and cancel pending prompts, authentication, and child processes on
  shutdown.
- 54ab304: Add `--host` and `--allowed-hosts` to `nylorun dev` and `nylorun start`, with
  `HOST` and `ALLOWED_HOSTS` environment equivalents. Loopback binds now answer only
  to their own address on the chosen port, so local development needs no setup on
  any port while DNS-rebinding pages are rejected. Publish with `--host 0.0.0.0` or
  list proxy host names to deploy on your own servers.
- 54ab304: Support portable Runtime protocol version 2 while retaining legacy Studio
  manifest support. Move the Studio CLI into Runtime: use `nylorun studio
--agent-url <url>` instead of `nylo studio`. Applications should install Runtime
  directly and keep Studio as a development dependency.

  Retain session lists and media across development reloads, and recognize agent
  file changes on Windows. Validate noninteractive creator startup during release
  verification with deferred provider configuration.

  Include Harness in this release so the creator does not rely on an unpublished
  compatibility pin. Ship and verify all four packages together.

Release notes are maintained with Changesets.

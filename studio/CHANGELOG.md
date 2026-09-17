# Changelog

## 0.5.0-beta

### Minor Changes

- Breaking: Studio reads `manifest.capabilities` (capability id, `kind`, `hasMiddleware`, tool
  schemas). `manifestCapabilities()` still accepts legacy `middleware` / `harness.manifest`
  documents. `StudioMiddlewareManifest` is now `StudioCapabilityManifest`.
- c5bbb1a: Breaking beta: make Harness run() a direct async state-in/state-out executor with serializable pauses, application scope, cancellation signals, awaited recording, agent-level output schemas, and registered tool families. Runtime owns session scheduling with memory-default or exclusive local storage and directly imports Harness contracts. Isolate Node adapters under runtime/node, stream observations incrementally, and add opt-in bounded token previews with Studio reconciliation. Migrate consumers and deployment guidance together; legacy event records remain archived, not automatically replayed.

## 0.4.2-beta

### Patch Changes

- 4badb5b: Move model execution to session startup, provide Runtime as a mountable Hono router, and generate Hono-first projects with supervised application and Studio development. Studio now resolves root-relative Runtime endpoints correctly for custom mount paths.

## 0.4.1-beta

### Patch Changes

- d27242c: Show stopped guardrail and failed model requests as errors in Studio. Runtime now emits a terminal AG-UI error instead of marking failed requests successful, and Studio displays the reported message. The guardrails example also checks text content parts sent by Studio, including mixed media input, before invoking the model.

## 0.4.0-beta

### Minor Changes

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

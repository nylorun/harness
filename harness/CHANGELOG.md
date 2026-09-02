# Changelog

All notable changes to `@nylorun/harness` are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Before 1.0, the public API is experimental: breaking changes may occur in minor releases, while patch releases are reserved for compatible fixes.

## [0.9.0-beta.1] - 2026-09-02

### Added

- Public provider translator helpers under `@nylorun/harness/model/adapters` for OpenAI-compatible
  Chat Completions, OpenAI Responses, and Anthropic Messages model loops.
- `MiddlewareManifest` and declared middleware contributions in `AgentManifest`, including static
  instructions, tool metadata, and model controls for host tooling such as Studio.

## [0.8.0-beta.1] - 2026-08-31

### Breaking changes

- `Agent()` now takes identity options instead of a model adapter. Migrate
  `Agent(adapter).use(...).build()` to
  `Agent({ id, name, instructions }).use(...).with(adapter).build()`.
- `.build()` exists only on `BoundAgentBuilder`, the type returned by a single `.with(onModelCall)`.
  `AgentBuilder` has `.use()` and `.with()` only.
- `AgentManifest` now includes `id` and `name`. Built agents expose the same fields as `agent.id`
  and `agent.name`.

### Added

- Optional constructor `instructions` compile as reserved `agent` middleware. A string is
  normalized to one instruction. Capability-specific instructions still go through `.use()`.

## [0.7.0-beta.1] - 2026-08-30

### Breaking changes

- Removed the bind-time directive argument: migrate `Agent(adapter, directive)` to
  `Agent(adapter).use({ id: "model", model: directive })`. `AgentManifest.model` is removed.
- Added `CapabilityDeclaration` support to `.use()`. A declaration owns one capability id, static
  tool/instruction/model contributions, and optional inline middleware.
- `ToolExecutionContext` now includes session, turn, step, and call identities.

### Added

- Declarations may own typed lazy session state through `CapabilityState`. State is shared only by
  that declaration's middleware and tools, is cold after seed recovery, and is disposed on
  `session.stop()` or recording failure.
- Added `capability.state.dispose.failed` observations for best-effort disposal failures.
- Added `capability.state.undeclared`, raised when session state is requested for a capability that
  declared none.

### Documentation

- Added concise package guidance for direct agent composition and the capability/service/host/core model.

## [0.6.0-beta.1] - 2026-08-29

### Breaking changes since 0.5.0-beta.1

- Removed tool adapters, `.with()`, `executeWith`, preflight, adapter concurrency controls, custom scheduling, adapter manifest fields, and adapter observations/errors.
- Tools now own their implementation through `execute(args, context)`. Harness centrally executes eligible siblings concurrently and commits normalized results in model-call order.
- Tool results are explicit `completed`, `denied`, and `failed` discriminated unions. Tool and model implementations may return `deferred` for a runtime handoff.

### Added

- Structural `SessionSeed` import through `agent.run({ seed })` and no-input `session.continue()`. Core validates typed JSON but deliberately leaves historical semantics and provider protocol validation to the host and model adapter.
- Optional awaited `SessionRecorder`, immutable full-state `SessionRecord` values, monotonic revisions, and effect barriers around input, model requests, candidates, tool results, waiting, final, and stop transitions.
- JSON-safe active model/tool/interaction records with stable invocation identities, tool ownership provenance, settled/deferred state, and opaque handoff tokens.
- `model.deferred`, `tool.started`, `tool.completed`, `tool.deferred`, `session.seeded`, `session.continued`, and `session.record.failed` observations.

### Reliability

- Recorder failure now fences later model/tool effects, quarantines late results, stops queued work, preserves the last successfully recorded revision, and exposes `session.record-failed` with the storage error as its cause.
- Deferred sibling batches settle fully without committing a partial model-facing `tool-results` entry.

## [0.5.0-beta.1] - 2026-08-28

### Breaking changes since 0.4.0-rc.1

- Replaced persistent `prefix` configuration with per-step `configuration`. Instructions, tools, model selection, and runtime context are assembled afresh for every model call; slot removal, context lifetimes, strict prefix policy, and Harness-owned drift auditing were removed. Middleware receives `turnId` and `stepId` to coordinate application-owned state.
- `model.prefix` and `model.started` were replaced by `model.requested`, emitted immediately before adapter invocation with the exact immutable `ModelCall` and JSON-safe attributed configuration/context snapshots.
- `tool()` now validates and normalizes its synchronous Zod object schema eagerly; raw tool literals retain first-bind preparation.

- Model adapters now receive the projected `ModelCall` as their first argument and `{ request, signal }` as their second. Implementations that consumed the prior request-shaped input must migrate to the projection and use `request` for the structured escape hatch.
- `InputHandle.consume()` and `AgentRunInput` were removed. Submit messages and interaction replies through the Session input API and await the returned completion handle instead.
- `session.observe()` now returns an idempotent unsubscribe function rather than the previous observer result. Observers remain live-only and do not replay history.
- Tool adapters and the tool facade removed the prior route-validation and route metadata methods. Tool definitions use `parameters` and `executeWith`; dispatch validation happens at the sealed Harness boundary.
- Harness-owned failures now use `HarnessError` with stable machine-readable codes. The prior outcome-code model has been replaced; see the migration table in the README for renamed and split codes. Foreign application, model, and adapter errors remain available as causes.

### Added

- `ModelCall` projection, including canonical system text, transcript messages, provider tool contracts, model directive, and session id.
- Explicit abort propagation through the Model adapter context.
- Stable structured Harness errors via `HarnessError`, `HarnessErrorCode`, and `isHarnessError`.
- Parallel sibling tool execution by default, with an optional shared per-adapter `maxConcurrentCalls` limit on `.with(adapter, options)`.

### Fixed

- Observe attributes are materialized only when a listener is registered. Transcript snapshots on `step.started` share the already-frozen step transcript rather than deep-copying it on every step.

[0.5.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.6.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.7.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.8.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.9.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness

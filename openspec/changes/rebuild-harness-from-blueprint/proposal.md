## Why

The current `@nylorun/harness` exposes a host-owned Session object and event vocabulary that predate the Nylorun Harness Blueprint. It cannot represent the Blueprint's Runtime admission boundary, record-authoritative loop, or bounded extension model without retaining incompatible assumptions.

The replacement must settle recovery, interrupt, and approval semantics before other packages depend on the new public surface.

## What Changes

- **BREAKING** Delete the existing `@nylorun/harness` implementation, tests, public exports, and package contract; rebuild the package from an empty implementation baseline.
- Introduce an independent `Agent = Model + Harness` kernel. An Agent binds one selected Model, serializable Harness configuration, executable ordered Step hooks, and five immutable Runtime functions.
- Replace the provider-stream, `createSession`, and host-event APIs with one Runtime-facing `harness.input(event, session)` entry point, typed record operations, and normalized Model, Tool, output, and observation contracts.
- Make the record authoritative: every input, lifecycle transition, Step, outbound attempt, Tool outcome, interaction, and terminal result is appended and folded before another loop decision.
- Define `idle`/`running` execution state; durable approval and clarification facts; safe-boundary interrupts that become next-Step context; and Runtime-owned input admission, ordering, claims, and duplicate prevention.
- Define recovery as **at-least-once**: an incomplete Model or Tool operation is retried with its stable operation id and a higher attempt number. Runtime and Tool hosts must tolerate repetition.
- Define multi-Tool approval behavior: a pending approval defers unstarted sibling Tools, resumes only the approved Tool on a matching approval, then starts the next Model Step with explicit completed and deferred results.
- Ship a concise `harness/Architecture.md` that records these architectural commitments and their consequences. It accompanies the package; `README.md` remains usage-focused.
- Keep the first package kernel-only: instructions, limits, `modelPolicy`, declared Tools, record projection, and ordered Step hooks. Profiles, modes, and capability composition are deferred.

## Capabilities

### New Capabilities

- `harness-kernel`: Independent Agent/Harness orchestration contract: Runtime boundary, record folding, safe input loop, Step hooks, at-least-once outbound attempts, Tool pipeline, and lifecycle invariants.

### Modified Capabilities

- None.

## Impact

- Affected code: the complete `harness/` package, including its manifest, source tree, tests, package documentation, and generated build output.
- Affected API: every current `@nylorun/harness` export is removed and replaced by the Blueprint-defined kernel. Consumers are intentionally not migrated in this change.
- Dependencies: the rebuilt package has no Nylorun production dependency and imports no Runtime, provider, transport, database, sandbox, or observability implementation. Runtime behavior exists only as injected function types.

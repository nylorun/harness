> **Superseded (2026-08-25).** The five Runtime adapter functions (`onStreamOutput`,
> `onObserveEvent`, and the rest of that boundary) are not the live harness contract.
> See `@nylorun/harness` README for `Agent.run`, `Session.input`, `Session.stream`,
> `Session.observe`, and `Session.stop`.

## ADDED Requirements

### Requirement: Independent package and architecture record
The rebuilt `@nylorun/harness` package SHALL be an independently buildable ESM TypeScript library. Its production dependency graph and source imports MUST exclude `@nylorun/runtime`, `@nylorun/agent`, the generator, Agent Platform packages, provider SDKs, database clients, transports, sandbox clients, and observability exporters. The published package MUST include `Architecture.md` as its concise record of accepted architectural decisions.

#### Scenario: Package boundary and documentation check
- **WHEN** the package build and package-content check run
- **THEN** they pass only when prohibited production dependencies and source imports are absent and `Architecture.md` is included in the distributable files.

### Requirement: Agent composition and configuration separation
The package SHALL expose an Agent composed from one selected Model descriptor, serializable Harness configuration, ordered executable Step hooks, and exactly five immutable Runtime functions. Serializable configuration SHALL contain instructions, limits, `modelPolicy`, declared Tools, and record projection. Step hooks MUST remain outside serializable configuration; profiles, modes, and capability composition MUST NOT be implemented by this version.

#### Scenario: Agent binding
- **WHEN** a Runtime constructs an Agent with a complete model, configuration, hook list, and adapter bundle
- **THEN** it receives a Harness binding whose configuration can be serialized independently of its hooks.

#### Scenario: Deferred composition features
- **WHEN** a caller attempts to configure a profile, mode, or capability composition API
- **THEN** the rebuilt public surface provides no such API.

### Requirement: Exact Runtime boundary and input ownership
The Agent SHALL bind exactly `onModelCall`, `onToolCall`, `onStoreRecord`, `onStreamOutput`, and `onObserveEvent`. `onStoreRecord` SHALL return an ordered stored-event list for load and exactly one stored event for append. The Runtime-facing Harness entry point SHALL accept one normalized input event and Session scope containing Session id and abort signal. The Runtime, not the Harness, SHALL authenticate, order, claim, wake, and deduplicate input.

#### Scenario: Complete adapter binding
- **WHEN** an Agent is constructed without one of the five Runtime functions
- **THEN** binding fails before the Harness loads a record or processes an input.

#### Scenario: Runtime-admitted event
- **WHEN** the Runtime delivers an already admitted input to `harness.input`
- **THEN** the Harness records and evaluates it without attempting to claim, reorder, or deduplicate it.

### Requirement: Record-backed state and event replay
The Harness SHALL load the stored Session record before it evaluates input, append every consequential fact through `onStoreRecord`, and fold the exact stored append result before its next decision. It SHALL expose pure initial-state, single-event fold, and replay fold helpers. The Harness MUST NOT allocate durable sequence numbers, mutate durable Session state directly, or derive state from output or observation.

#### Scenario: Replayed and live state agree
- **WHEN** a Session reaches any recorded Step boundary
- **THEN** replaying the retained stored record through the public fold produces the same state the live Harness uses for its next decision.

#### Scenario: Store failure
- **WHEN** loading or appending a required record event fails
- **THEN** the Harness does not invent a lifecycle transition, sequence number, or substitute event.

### Requirement: Two-state lifecycle, eligibility, and safe interrupts
The folded execution lifecycle SHALL contain only `idle` and `running`. Approval and clarification SHALL be durable `pendingInteraction` facts with stable correlation ids, never lifecycle states. An ordinary queue input starts an eligible idle Session; a matching approval or response starts a new Turn and clears the matching interaction. An interrupt received while execution is running SHALL be recorded without starting another loop, then claimed only after the active Step closes and added as context to the next Step of the same Turn. Model and Tool execution MUST NOT be preempted.

#### Scenario: Interrupt at a safe boundary
- **WHEN** an interrupt is recorded while a Model call or Tool execution is in progress
- **THEN** that work completes normally and the Harness adds the interrupt to the next Step only after it closes and reloads the record.

#### Scenario: Pending interaction queues ordinary input
- **WHEN** an idle Session has a pending interaction and receives ordinary queue or interrupt input
- **THEN** the input remains durably queued until a matching approval or response clears the interaction.

### Requirement: At-least-once outbound recovery
Before each Model or Tool invocation, the Harness SHALL persist a deterministic `operationId` and an increasing `attempt` number. The Runtime function SHALL receive both values. If replay finds a started attempt without a completion, the Harness SHALL append the next attempt and invoke the same Runtime function again. The package SHALL document that Model and Tool work is at-least-once and MAY repeat after recovery.

#### Scenario: Incomplete Tool attempt recovers
- **WHEN** the record contains a Tool attempt start without its completion after recovery
- **THEN** the Harness appends a higher attempt for the same operation id and invokes `onToolCall` again.

#### Scenario: Incomplete Model attempt recovers
- **WHEN** the record contains a Model attempt start without its completion after recovery
- **THEN** the Harness appends a higher attempt for the same operation id and invokes `onModelCall` again.

### Requirement: Bounded Step-hook extension model
The Harness SHALL run Step hooks once per Step in deterministic configured order after recording Step start and before composing Model work. A hook context SHALL provide read-only serializable configuration, folded state, admitted input, identities, and append-only request contributions. Hooks MAY add instructions or context, narrow Model-visible declared Tools, or return stop; they MUST NOT call Runtime functions, persist events, mutate state, add Tools, create interactions, or alter a completed core result.

#### Scenario: Hook stop
- **WHEN** a hook returns a stop result
- **THEN** remaining hooks and all Model and Tool work are skipped, and the Harness records and emits one terminal stopped Turn.

#### Scenario: Hook error
- **WHEN** a hook throws
- **THEN** the Harness records an errored Step and Turn, returns the Session to idle, and skips remaining hooks and core work.

### Requirement: Normalized Model and Tool pipeline
For a non-stopped Step, the Harness SHALL compose one Model request, persist its attempt and normalized result, and use `onModelCall` for execution. For each requested Tool it SHALL persist intent, apply Harness policy, invoke `onToolCall` only when allowed, and persist exactly one normalized result, denial, or deferral. Runtime Tool enforcement is final.

#### Scenario: Multi-Tool approval defers siblings
- **WHEN** a requested Tool requires approval and later Tools from the same Model result have not started
- **THEN** the Harness records the approval interaction and a deferred result with reason `approval-pending` for every unstarted sibling before it closes the Turn.

#### Scenario: Approval resumes one Tool then Model
- **WHEN** a matching approval input arrives
- **THEN** the Harness runs only the approved Tool, records its result, and starts the next Model Step with the completed and deferred Tool results rather than resuming the old Tool batch.

#### Scenario: Denied Tool
- **WHEN** Harness policy denies a requested Tool
- **THEN** the Harness records a normalized denied result and does not call `onToolCall` for that Tool.

### Requirement: Durable terminal output and best-effort observation
The Harness SHALL append and fold terminal Step, Turn, lifecycle, and pending-interaction facts before invoking `onStreamOutput`. It SHALL use `onObserveEvent` only for non-authoritative signals. Output or observation failure MUST NOT write the record, change folded state, retry Model or Tool work, clear an interaction, or alter the durable result of `input()`.

#### Scenario: Interaction delivery ordering
- **WHEN** a Model clarification or Tool approval becomes pending
- **THEN** the pending interaction and idle Turn end are durably recorded before `onStreamOutput` receives the user-facing request.

#### Scenario: Output delivery failure
- **WHEN** terminal output delivery fails after the Turn is durably closed
- **THEN** the folded Session state remains closed and no Model or Tool call is repeated.

### Requirement: Complete breaking replacement
The package SHALL remove the legacy `createSession`, provider-stream adapter, host event, legacy session-status, and previous event-vocabulary exports. The new public API SHALL consist only of the independent Agent/Harness kernel, its Blueprint-defined contracts, and pure record-folding helpers.

#### Scenario: Legacy import rejected
- **WHEN** a consumer type-checks an import of a removed legacy export
- **THEN** TypeScript reports that the export is unavailable.

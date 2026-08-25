> **Superseded (2026-08-25).** The in-process kernel no longer uses a five-function
> `RuntimeAdapters` boundary (`onModelCall`, `onToolCall`, `onStoreRecord`, `onStreamOutput`,
> `onObserveEvent`). Harness is a build-only factory. Conversation I/O is `Agent.run()` →
> `Session.input()` / `Session.stream()` / `Session.observe()` / `Session.stop()`. Tool adapters
> expose `validateRoute` / `execute` only. See `@nylorun/harness` README.

## Context

`@nylorun/harness` is being replaced, not migrated. The new package is the independent in-process kernel in the Blueprint: an Agent is a selected Model plus a configured Harness, and the Runtime runs that Agent as a durable Session.

The Runtime owns authentication, input ordering, duplicate prevention, Session claims, persistence, credentials, provider clients, Tool hosts, delivery, and telemetry. The Harness owns loop order, record-and-fold discipline, request composition, and normalized outcome resolution.

## Goals / Non-Goals

**Goals:**

- Deliver an independently buildable ESM TypeScript package with a small, explicit public contract.
- Make the stored record sufficient to replay live state and continue recovery work.
- Make interrupts, approval, clarification, outbound recovery, and multi-Tool behavior deterministic.
- Keep extension bounded to declarative configuration and pre-Model Step hooks.

**Non-Goals:**

- Runtime, generator, Agent Platform, or consumer migration.
- Runtime implementations, provider clients, credentials, transport, persistence, Tool hosts, sandboxing, or exporters.
- Profiles, modes, capability binding, skills, MCP, retries unrelated to recovery, compaction policy, or a public client Session API.

## Target package structure

```text
harness/
├── src/
│   ├── index.ts              # public exports only
│   ├── types.ts              # contracts and discriminated event/outcome unions
│   ├── agent.ts              # immutable Agent binding
│   ├── harness.ts            # public input facade
│   ├── fold.ts               # pure replay and transition validation
│   ├── hooks.ts              # ordered Step-hook execution
│   └── core.ts               # loop, recovery, Model, and Tool orchestration
├── test/
│   ├── fixtures.ts           # deterministic five-function Runtime doubles
│   ├── fold.test.ts          # replay and event legality
│   ├── harness.test.ts       # input, lifecycle, interrupt, and output order
│   ├── hooks.test.ts         # hook boundaries and stopping
│   ├── core.test.ts          # attempts, Model/Tool, approval, recovery
│   └── boundary.test.ts      # public surface and dependency boundary
├── scripts/check-package.mjs # tarball allowlist and dependency guard
├── Architecture.md           # concise architectural decision record
├── README.md                 # public usage and scope
├── package.json
└── tsconfig.json
```

| File | Purpose / pseudocode |
|---|---|
| `src/agent.ts` | `new Agent({ model, harness: { config, stepHooks }, runtimeAdapters })`; validates and freezes the binding for the Agent lifetime. |
| `src/harness.ts` | `input(event, scope) { return runInput(bound, event, scope); }`; no loop transitions live here. |
| `src/core.ts` | `load → append/fold input → resolve eligibility → while running: Step → refresh record → interrupt? → next Step`; owns all Model/Tool attempts and terminal resolution. |
| `src/fold.ts` | `fold(events) = events.reduce(foldOne, initialState())`; rejects illegal lifecycle, interaction, and attempt transitions. |
| `src/hooks.ts` | `for (hook of hooks) { contribution = await hook(context); if (stop) return stop; }`; hooks have no Runtime handle. |
| `Architecture.md` | Decision, rationale, and consequence table; it records why the kernel has these boundaries without duplicating API reference. |

## Decisions

### 1. Independent, clean-breaking package

Delete the existing package contents and recreate a strict NodeNext ESM package with zero Nylorun production dependencies. The public entry point exports only the new Agent/Harness kernel, its typed contracts, and pure fold helpers. It includes `Architecture.md` in the distributable package.

Compatibility shims are rejected: they would preserve the old Session object, provider stream, and lifecycle semantics.

### 2. Agent binding separates data from executable hooks

```ts
type AgentOptions = {
  model: ModelDescriptor;
  harness: {
    config: SerializableHarnessConfig;
    stepHooks: readonly StepHook[];
  };
  runtimeAdapters: RuntimeAdapters;
};

type SerializableHarnessConfig = {
  instructions: readonly Instruction[];
  limits: HarnessLimits;
  modelPolicy: ModelPolicy;
  tools: DeclaredTools;
  record: RecordProjection;
};
```

The selected `model` belongs to Agent identity. `modelPolicy` controls allowed behavior for that selected Model. Hooks are executable and therefore deliberately outside serializable configuration. Profiles, modes, and capability composition are not part of this version.

### 3. Five flat Runtime functions are the whole infrastructure boundary

```ts
type RuntimeAdapters = Readonly<{
  onModelCall(request: ModelCallRequest): Promise<ModelOutcome>;
  onToolCall(request: ToolCallRequest): Promise<ToolOutcome>;
  onStoreRecord: OnStoreRecord;
  onStreamOutput(event: StreamOutput): Promise<void>;
  onObserveEvent(event: ObserveEvent): void | Promise<void>;
}>;

interface OnStoreRecord {
  (request: { operation: "load"; sessionId: string }): Promise<readonly StoredEvent[]>;
  (request: { operation: "append"; sessionId: string; event: UnstoredEvent }): Promise<StoredEvent>;
}
```

The Runtime constructs or binds the Agent once. It alone authenticates, orders, claims, wakes, and deduplicates input. The Harness never receives an infrastructure client or handle.

### 4. Record first, fold before decision

The Harness appends each `UnstoredEvent` through the Store, receives a Store-sequenced `StoredEvent`, and folds that result before its next decision. It never allocates a durable sequence or mutates Session state directly. Store load and append failures stop the current invocation without inventing state.

| Event group | Required facts |
|---|---|
| Input and lifecycle | `input.received`, `session.running`, `turn.started`, `step.started`, `step.ended`, `turn.ended`, `session.idle` |
| Model attempt | `model.attempt.started`, `model.attempt.completed` |
| Tool attempt | `tool.intent`, `tool.attempt.started`, `tool.attempt.completed`, `tool.deferred` |
| Interaction | `interaction.pending`, `interaction.cleared` |

### 5. Two execution states, separate interaction facts

Folded lifecycle is only `idle` or `running`. `pendingInteraction` is a durable approval or clarification fact with a correlation id. It always closes the active Step and Turn before output is delivered. Matching `approve` and `respond` events clear the matching fact and start a new Turn; ordinary queued input remains recorded until eligible.

### 6. Core owns the loop and safe-boundary interrupts

`harness.input(event, scope)` loads, appends, and folds its event. If the event is not eligible to begin an execution—such as an interrupt received while the Session is already running—it returns after recording it. The active `core.ts` loop refreshes the record after each completed Step, claims the next ordered interrupt, and includes that message in the next Step's context. No Model call or Tool execution is preempted.

```ts
while (state.lifecycle === "running") {
  await record(stepStarted());
  const outcome = await executeStepOrResumePendingTool();
  await record(stepEnded(outcome));
  state = await loadAndFold();
  nextStepContext = claimQueuedInterrupt(state) ?? nextStepContext;
  if (isTerminal(outcome)) return await endTurn(outcome);
}
```

### 7. Recovery is intentionally at-least-once

Before every outbound Model or Tool invocation, the Harness stores an attempt with a deterministic `operationId` and an increasing `attempt` number. `operationId` is derived from Session, Turn, Step, and—where applicable—the Tool call id. If replay finds an attempt with no completion, recovery appends the next attempt and calls the same Runtime function again. The adapter receives both values for correlation; it is not required to deduplicate. A Tool may therefore execute more than once.

At-most-once was rejected because this kernel has no durable host-side result oracle, and a sixth recovery adapter would violate the fixed boundary.

### 8. Step hooks are bounded preparation only

Each Step starts with fresh read-only state, input, identities, serializable config, and append-only request contributions. Hooks run once in configured order and may add instructions/context, narrow declared Tool visibility, or stop. A stop or hook error records a terminal outcome. Hooks cannot call Runtime functions, write records, add Tools, create interactions, mutate state, or alter a completed core result.

### 9. Model and Tool outcomes are normalized and complete

`onModelCall` returns a discriminated normalized response, error, or clarification request. The Harness records its attempt and result. For Tools it records intent, applies Harness policy, records every resulting outcome, and delegates only allowed Tools to Runtime enforcement.

If a Tool requires approval, the Harness records the interaction and records every unstarted sibling Tool from that Model response as `deferred` with reason `approval-pending`. On matching approval, it executes only the approved Tool, records the result, and begins the next Model Step; it does not resume the old Tool batch.

### 10. Output and observation are effects, never authority

After durable terminal facts exist, `onStreamOutput` receives the terminal response, stop, error, or interaction request. `onObserveEvent` emits best-effort signals. Failures from either are isolated: they cannot write the record, change state, retry core work, clear interactions, or change `input()`'s already-durable result.

## Risks / Trade-offs

- [At-least-once Tools can repeat side effects] → Require operation id and attempt in every Model/Tool request, document the guarantee prominently, and test recovery repetition.
- [Interrupt record refresh exposes concurrent writes] → Runtime owns ordering and claims; the Harness only reloads Store-authoritative state at the documented safe boundary.
- [Deferred Tool siblings can surprise providers] → Record them explicitly and surface their deferred results to the next Model Step.
- [Event/fold drift] → Test every declared event, all legal transitions, and replay equivalence using the same public union.
- [Hooks become an authority bypass] → Expose no Runtime handle or mutable state in hook-facing types and behavior tests.

## Migration Plan

1. Replace only the scoped `harness/` package; preserve unrelated repository changes.
2. Build the independent package, its decision record, type contracts, fold, loop, and tests together.
3. Run package checks and inspect the tarball, including `Architecture.md`.
4. Do not migrate Runtime, generator, or Platform consumers and do not publish a compatibility shim in this change.
5. Roll back before release by restoring the prior package from version control; after release, select the prior package version rather than carrying legacy behavior forward.

## Open Questions

- None. The initial kernel scope, interrupt behavior, recovery guarantee, and multi-Tool approval behavior are settled.

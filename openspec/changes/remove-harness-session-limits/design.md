## Context

Native sessions currently normalize per-session turn, step, and wall-clock limits. The scheduler uses the timeout to abort active work and preserves its deadline across approval resumes; the turn runner creates built-in tripwires for count limits. Runtime repeats this configuration in authored definitions and host options. Step middleware already owns policy decisions through `Tripwire`, but only receives opaque turn and step identifiers.

## Goals / Non-Goals

**Goals:**

- Remove all native limit configuration and implicit execution ceilings.
- Preserve serialized session execution, explicit cancellation, tool interactions, and middleware tripwires.
- Give middleware deterministic numeric progress information for count-based policies.
- Remove all runtime authoring and host configuration that would otherwise be dead.

**Non-Goals:**

- Provide a stock limiter middleware.
- Preserve the old wall-clock timeout semantics through middleware.
- Change the distinct adapter-protocol capabilities that describe max-token or tool-result enforcement.

## Decisions

### Native sessions are policy-free

The scheduler will compose only explicit abort sources: session close, active cancellation, and an input signal. The turn runner will advance until terminal output, cancellation, or an existing model/middleware tripwire. No replacement defaults are retained.

Alternative considered: retain an internal safety timeout. Rejected because it remains a hidden policy and contradicts application ownership.

### Middleware receives execution positions

`StepInput` will expose immutable one-based `turnNumber` and `stepNumber`. A resumed tool plan retains its turn number; its following model invocation receives the next step number. Middleware can issue step- or session-scoped tripwires using those values.

Alternative considered: require middleware to count opaque IDs. Rejected because it creates avoidable per-session bookkeeping and unreliable cleanup.

### Runtime removes the forwarding surface

Runtime `Run`, deprecated `Agent`, resolved agent configuration, and host runtime options will no longer accept or pass limits. This prevents accepted-but-ignored configuration after the harness removal.

## Risks / Trade-offs

- [Unbounded accidental loops] → Applications must define middleware policy or cancel sessions; documentation makes this ownership explicit.
- [No full-turn timeout replacement] → Hosts use explicit cancellation/deadline control. Existing step middleware cannot safely time tool work and approval waits, so no partial replacement is introduced.
- [Breaking TypeScript upgrade] → Type tests assert that the removed fields are rejected and migration documentation directs developers to middleware.

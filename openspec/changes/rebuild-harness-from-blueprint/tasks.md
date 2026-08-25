## 1. Replace the package baseline

- [x] 1.1 Inventory the scoped `harness/` contents, then delete only its existing implementation, tests, exports, and package contract; preserve unrelated repository changes.
- [x] 1.2 Recreate the package manifest, TypeScript setup, ESM entry point, README, `Architecture.md`, and package-content check with no Nylorun production dependency or Runtime integration assumption.
- [x] 1.3 Include `Architecture.md` in the package tarball allowlist and add a boundary check for prohibited production dependencies and source imports.

## 2. Define the kernel contracts and record model

- [x] 2.1 Define public data types for selected Model, serializable Harness configuration, separate Step hooks, normalized inputs, Session scope, events, state, interactions, request contributions, Model/Tool outcomes, output, and observation.
- [x] 2.2 Define and validate the exact five-function Runtime boundary, including overloads for Store load and append results.
- [x] 2.3 Define the event union and pure initial-state, single-event fold, and replay fold helpers for lifecycle, interaction, Tool deferral, and outbound attempts.
- [x] 2.4 Add type-level and unit contract tests for adapter completeness, serializable configuration separation, legal event folding, and legacy-export absence.

## 3. Implement input, lifecycle, and recovery

- [x] 3.1 Implement `harness.input(event, session)` as the thin public facade over the `core.ts` loop: load/fold, append/fold input, and evaluate Runtime-admitted eligibility.
- [x] 3.2 Implement `idle`/`running`, Turn and Step boundaries, queued ordinary inputs, and correlated approval/clarification resumes.
- [x] 3.3 Implement safe-boundary interrupt refresh: record an interrupt without a second loop, reload/fold after the active Step, and add the claimed interrupt to next-Step context.
- [x] 3.4 Persist deterministic Model and Tool operation ids with monotonically increasing attempts; resume incomplete operations as at-least-once calls after recovery.
- [x] 3.5 Add deterministic in-memory Runtime fixtures and replay tests for input eligibility, lifecycle, interrupts, store failures, and repeated recovery attempts.

## 4. Implement hooks, Model, and Tool execution

- [x] 4.1 Implement fresh Step-hook contexts, deterministic order, append-only contributions, monotonic Tool visibility, stop handling, and normalized hook-error termination.
- [x] 4.2 Implement Model request composition, attempt persistence, normalized response/error/clarification outcomes, and next-Step request context.
- [x] 4.3 Implement Tool intent, Harness policy, Runtime call, normalized completion/denial/failure, and final Runtime enforcement.
- [x] 4.4 Implement approval-required suspension: defer unstarted sibling Tools, close the Turn, resume only the approved Tool, and begin the next Model Step with explicit completed/deferred results.
- [x] 4.5 Add behavior tests for hook order/stop/error, no Runtime authority in hooks, Tool policy, multi-Tool approval deferral, at-least-once recovery, and clarification flow.

## 5. Complete documentation and release verification

- [x] 5.1 Write `Architecture.md` as the concise decision/rationale/consequence record for package independence, boundary ownership, folding, lifecycle, interrupts, recovery, Tools, hooks, and non-authoritative effects.
- [x] 5.2 Rewrite README for the independent kernel’s usage, public surface, at-least-once guarantee, and explicitly deferred integrations.
- [x] 5.3 Implement terminal and interaction delivery after durable facts, with best-effort observation and failure isolation.
- [x] 5.4 Run `npm run check` in `harness/`, inspect `npm pack --dry-run`, and confirm the published artifact contains only intended `dist/**` outputs, README, LICENSE, and `Architecture.md`.

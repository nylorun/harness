## 1. Native harness execution

- [x] 1.1 Remove the public session-limits type, configuration field, export, defaults, validation, and deadline handling.
- [x] 1.2 Make the native turn runner unbounded while preserving explicit cancellation and stale-result protection.
- [x] 1.3 Add immutable turn and step positions to middleware input and propagate them through normal and resumed turns.

## 2. Harness tests and documentation

- [x] 2.1 Replace native limit and deadline tests with application-owned middleware policy coverage.
- [x] 2.2 Add type-level coverage that rejected legacy session limits and document the policy-free execution contract.

## 3. Runtime surface

- [x] 3.1 Remove limits from runtime authoring, resolved configuration, host options, and session creation.
- [x] 3.2 Update runtime type and behavior tests and regenerate the authoring contract reference.

## 4. Verification

- [x] 4.1 Run harness and runtime checks, then validate the OpenSpec change.

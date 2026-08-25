## 1. Contract and compatibility foundation

- [x] 1.1 Inventory the existing public `@nylorun/agent` adapter types and classify each field as protocol-v1, legacy compatibility, or runtime-internal.
- [x] 1.2 Add protocol-v1 types for harness capabilities, agent requirements, compatibility diagnostics, normalized errors, usage, and execution outcomes in `agent/src/index.ts` or focused contract modules.
- [x] 1.3 Retain the global symbol carrier and add runtime shape/version validation for protocol-v1 harness adapters.
- [x] 1.4 Implement pure, SDK-independent requirement derivation from resolved agent definitions, discovered tools, skills, MCP entries, execution options, and host policy.
- [x] 1.5 Implement the shared capability validator, including blocking and non-blocking diagnostics with stable diagnostic codes and remediation text.
- [x] 1.6 Add a legacy adapter converter/deprecation path and tests covering accepted legacy adapters, invalid carriers, and protocol-v1 validation.

## 2. Execution lifecycle and event semantics

- [x] 2.1 Define `ExecutionResult` terminal statuses, normalized error/usage fields, and outcome-to-session reconciliation rules.
- [x] 2.2 Evolve `PreparedAgent.start()` and `AgentExecution` so current-protocol adapters return a normalized terminal outcome while preserving cancellation support.
- [x] 2.3 Update runtime binding to record exactly one runtime-owned session lifecycle, fold normalized outcomes correctly, and record adapter-protocol contradictions as failures.
- [x] 2.4 Define and document the normalized payload and ordering contract for model, tool, message, error, and provider diagnostic events.
- [x] 2.5 Add runtime tests for completion, provider failure, cancellation during preparation and execution, limit failure, and contradictory event/outcome handling.

## 3. Build, manifest, and host admission

- [x] 3.1 Integrate definition-known compatibility validation into `runtime/src/plugin.ts` and replace coarse portability-only refusal paths with shared diagnostics.
- [x] 3.2 Add harness protocol/capability and derived-requirement snapshots to the manifest schema, digest, serialization, and deterministic-build tests.
- [x] 3.3 Add host policy inputs for required model-routing, durability, streaming, integrations, and enforceable limits.
- [x] 3.4 Run environment-dependent compatibility validation before adapter preparation and prevent incompatible sessions from starting.
- [x] 3.5 Update `nylo adapter probe` to report protocol version, compatibility diagnostics, and unknown host-dependent checks without certifying them as passes.
- [x] 3.6 Add build and host-admission fixtures covering no-tools harnesses, bridged tools, routing policy conflicts, required token streaming, and unsupported durability.

## 4. Harness migrations and conformance suite

- [x] 4.1 Migrate `@nylorun/harness` as the protocol-v1 reference adapter, declaring only capabilities verified by the native loop and returning normalized outcomes.
- [~] 4.2 ~~Migrate `@nylorun/harness-openai-agents`~~ — withdrawn 2026-08-21; the package was removed with the multi-harness strategy.
- [~] 4.3 ~~Normalize OpenAI adapter errors, cancellation, tool failures, and completed runs~~ — withdrawn with 4.2.
- [x] 4.4 Create reusable adapter conformance fixtures for each declared capability: tool execution, streaming granularity, model usage, cancellation, limits, event ordering, and terminal outcomes.
- [x] 4.5 Run the conformance fixtures against the native harness, correcting capability declarations instead of masking unsupported behavior.

## 5. Public surface, documentation, and verification

- [x] 5.1 Export protocol-v1 types and validator APIs from the intended `@nylorun/agent` and `@nylorun/runtime` public entry points without exposing provider SDK types.
- [x] 5.2 Update package READMEs and adapter-author guidance to distinguish definition portability, target compatibility, first-class harnesses, and compatibility harnesses.
- [x] 5.3 Document third-party adapter migration, the legacy support window, and how host policy affects harness admission.
- [x] 5.4 Update type-level public API tests, package contract checks, and generated contract-reference expectations.
- [x] 5.5 Run `npm run check` and `npm run build` from the repository root; fix all contract, type, deterministic-manifest, and harness conformance failures.

## Context

The current adapter boundary in `agent/src/index.ts` already separates immutable host preparation (`prepare`) from per-session execution (`start`). Harnesses describe broad record-safety properties with `portable`, event coverage, durability, concurrency, compaction, and an unsupported-capability string list. The runtime rejects a small set of record-incompatible descriptions at build time, while the OpenAI Agents implementation translates tools and streaming events where the SDK permits it.

This is a cross-package protocol change. The contract must remain SDK-neutral, support independently installed harness packages, retain the global-symbol carrier, and avoid claiming equivalence where an SDK cannot enforce a Nylo guarantee.

## Goals / Non-Goals

**Goals:**

- Make agent-to-harness compatibility deterministic, inspectable, and enforceable before a session starts.
- Preserve the existing prepare-once/start-per-session lifecycle while adding versioned capabilities and a normalized terminal outcome.
- Separate agent-definition portability from compatibility with a particular harness and host policy.
- Keep provider SDK types out of `@nylorun/agent` and preserve adapter-package isolation.
- Make protocol incompatibility fail before an artifact is prepared or run.

**Non-Goals:**

- Reimplement every provider SDK feature or make all harnesses semantically identical.
- Make provider-native conversation/thread state portable across harnesses.
- Replace the Nylo event store or redesign durable session persistence in this change.
- Require all adapters to support tools, MCP, skills, or Nylo-managed model routing.

## Decisions

### 1. Version the contract and use structured capabilities

Introduce a `protocol` discriminator, initially `nylorun.harness/v1`, on the adapter description and replace the unstructured `unsupported` list with a `HarnessCapabilities` object. Capabilities cover tools, skills, MCP, streaming granularity, model-routing ownership, session mode, usage fidelity, cancellation, and enforceable limits. Existing record-safety fields are retained or incorporated where they remain platform requirements.

The global `AGENT_HARNESS` symbol remains the cross-copy identity mechanism. The carrier is a frozen envelope with a `protocol` discriminator and named `adapter` field. Runtime validation checks the brand, protocol version, and complete adapter shape, so a same-symbol object cannot accidentally be accepted as a current compatible adapter.

Alternative considered: infer capability support from emitted events. Rejected because event observation is too late to prevent invalid deployment and cannot express non-event concerns such as credentials or max-token enforcement.

### 2. Derive requirements separately from capabilities

The runtime/compiler derives `AgentRequirements` from the resolved definition, discovered tool modules, skills, MCP configuration, requested execution behavior, and explicit host policy. Compatibility is determined by a pure `validateHarnessCompatibility(requirements, capabilities)` function that returns typed diagnostics with a severity and remediation.

Requirements distinguish mandatory guarantees from acceptable degradations. For example, declared function tools require native or bridged tool support; token streaming only requires token-level support when explicitly requested by caller or deployment policy. Harness-owned routing is allowed only when host policy allows it.

Alternative considered: retain `portable` and add more string values to `unsupported`. Rejected because it cannot express directionality—what the agent requires versus what the harness provides—or make policy decisions safely.

### 3. Validate twice: artifact construction and host admission

Build validation evaluates definition-only requirements against the selected harness and records the resolved capability profile in `nylo.manifest.json`. It fails on unconditional incompatibilities, such as an agent declaring tools for a harness that supports none. It does not reject environment-dependent requirements that cannot be known at build time.

Host admission repeats validation with host policy and resolved configuration: approved credential/routing mode, required durability, requested streaming mode, enforced limits, and integrations. It rejects the run before `prepare` or `start` when compatibility is impossible.

Alternative considered: runtime-only validation. Rejected because an artifact that is inherently incompatible should not be published as a valid target, and developers need feedback before deployment.

### 4. Preserve push events, add a terminal outcome

Keep `StartInput.emit` and the runtime’s event folding to avoid a disruptive event transport rewrite. Evolve `AgentExecution.done` from `Promise<void>` to `Promise<ExecutionResult>`, with a defined status (`completed`, `failed`, `cancelled`, or `limit_exceeded`), optional output, normalized error, and optional usage. The runtime reconciles this outcome with emitted events, rather than fabricating success after a cancelled or failed SDK run.

Event ownership is explicit: the runtime owns session lifecycle events; the harness owns model/tool/message/error events and must emit only capabilities it declares. Provider-native payloads are namespaced optional diagnostic data, not Nylo public event fields.

Alternative considered: have adapters return an `AsyncIterable` for all events. Deferred because current event persistence and live readers are built around the runtime sink; it is a useful future transport option but not required to make compatibility correct.

### 5. Model routing is a capability and host policy decision

Adapters declare either `nylorun` or `harness-owned` model routing. A Nylo-routed harness consumes the resolved model gateway. A harness-owned adapter must surface its credential/routing mode in compatibility checks and cannot run where host policy requires Nylo-managed credentials, governance, or tracing.

This permits the current OpenAI Agents adapter to continue using its SDK model provider while removing ambiguity about whether Nylo credential resolution is authoritative.

## Risks / Trade-offs

- [Breaking third-party adapters] → This is a clean protocol change; adapters must publish the current carrier and description before they can be loaded.
- [Capability taxonomy becomes overly detailed] → Start with guarantees that influence correctness, policy, or observable output; add optional capabilities only through protocol revisions.
- [Build and runtime checks drift] → Put requirement derivation and compatibility validation in `@nylorun/agent` as pure shared functions and test both callers against the same fixtures.
- [Adapters overclaim support] → Add a reusable conformance suite that tests each declared capability, event ordering, cancellation, limits, and outcomes.
- [Outcome/event disagreement] → Define reconciliation rules and treat terminal contradictions as an adapter protocol error that is recorded as a failed run.

## Migration Plan

1. Add protocol-v1 types, a branded versioned carrier, pure requirement derivation, and diagnostics in `@nylorun/agent`.
2. Update the native harness first as the reference implementation and establish conformance fixtures.
3. Update the OpenAI Agents harness to declare only verified capabilities and return normalized outcomes.
4. Update runtime binding, Vite validation, manifest generation, CLI probe, public exports, and documentation to consume the shared validator.
5. Reject stale or malformed harness carriers and descriptions before an artifact is prepared or run.
6. Record only serializable harness metadata in the manifest; reconstruct harness objects locally from the artifact bundle.

## Open Questions

- Which user-facing configuration selects mandatory token streaming versus acceptable message-level streaming?
- Should the manifest capture a capability snapshot only, or also an explicit agent requirement snapshot for offline deployment checks?
- What exact versioning and support-window policy applies to third-party protocol implementations?

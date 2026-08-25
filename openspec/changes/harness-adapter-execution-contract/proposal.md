> **Superseded in part (2026-08-21).** Nyloagents no longer ships multiple harness packages for v1.
> `@nylorun/harness-openai-agents` has been removed from the repository; working with Claude Code,
> Codex and other external agent runners is being reframed as a capability of an agent and of the
> harness, alongside skills, MCP and memory, rather than as a per-runner harness package. The
> versioned adapter protocol below still stands: it is the seam a developer uses to run their own
> harness on the Nylo runtime.

## Why

Nyloagents supports native and SDK-backed harnesses, but the adapter contract represents compatibility through a coarse `portable` flag, an unstructured unsupported-capability list, and event coverage claims. That lets a selected harness appear portable even when an agent's declared tools, skills, model-routing policy, limits, or session guarantees cannot be preserved.

The platform needs deterministic, pre-execution compatibility validation and normalized execution outcomes so a change of harness is explicit about its behavioral guarantees rather than silently reducing them at runtime.

## What Changes

- Add a versioned harness protocol with structured, machine-readable capability declarations.
- Derive an agent's execution requirements from its resolved definition, discovered tools, skills, MCP configuration, and host policy.
- Validate the selected harness against those requirements during build and again when a host prepares a run; produce actionable diagnostics for incompatible targets.
- Evolve adapter execution to expose a normalized completion outcome and normalized failure/cancellation semantics while retaining the current `prepare()` lifecycle.
- Define ownership and minimum payloads for session, model, tool, message, and error events; retain provider-specific events only as optional diagnostic data.
- Update the native harness, manifests, CLI probing, and contract tests to use the new protocol.
- **BREAKING**: third-party `AgentAdapter` implementations must opt into the versioned adapter protocol before they can be treated as compatible with the current runtime.

## Capabilities

### New Capabilities

- `harness-capability-negotiation`: declares and validates the execution features a harness can faithfully provide for an authored agent and a deployment host.
- `harness-execution-outcomes`: standardizes adapter lifecycle events, terminal outcomes, cancellation, and usage reporting across harnesses.

### Modified Capabilities

- None.

## Impact

- Affected packages: `agent`, `runtime`, and `harness`.
- Affected surfaces: `AgentAdapter`, `AdapterDescription`, prepared execution types, Vite build validation, runtime admission, CLI adapter probe, generated manifest, and public type exports.
- Third-party harness packages need a migration path and compatibility shim for the new protocol version.

# @nylorun/agent

The portable contract between Nylo's host runtime and a selected harness. It contains the adapter
brand and definition/compiler contracts; it never executes an agent loop.

`@nylorun/agent/compiler` discovers the standard folder layout without depending on Vite.
`@nylorun/agent/definition` owns the pure definition merge and validation rules used by every
builder. A harness implements `prepare()` once for an immutable compiled definition, then its
prepared object implements `start()` for each session.

## Harness protocol and compatibility

`nylorun.harness/v1` separates a portable folder definition from a compatible execution target.
Every current adapter declares structured capabilities for tools, skills, MCP, streaming, model
routing, sessions, usage, cancellation, and limits. The shared
`deriveAgentRequirements()` and `validateHarnessCompatibility()` APIs are intentionally provider
SDK-free so both the builder and host make the same decision.

An adapter is not required to implement every capability. A deployment is rejected only when the
resolved agent or host policy requires a guarantee the selected adapter cannot provide. Adapters
must return a normalized terminal outcome (`completed`, `failed`, `cancelled`, or
`limit_exceeded`) from each execution; session lifecycle events remain runtime-owned.

An in-process harness value is a frozen `AgentHarness` envelope branded with
`Symbol.for("nylorun.agent.harness")`. It carries `protocol: "nylorun.harness/v1"`, a named
`adapter`, and optional instructions. `parseAgentHarness()` validates this envelope before
authoring or binding proceeds. The carrier is process-local; deployment boundaries use the
serializable harness metadata in `nylo.manifest.json`, then reconstruct the harness by importing
the artifact locally.

# Agent execution

Agent definitions describe capabilities. The engine advances execution; a host
persists progress and connects it to external systems.

## Language

**Manifest**: The serializable description of an agent's declared capabilities.
Its canonical hash identifies the definition used by an execution.

**Binding**: The local pairing of a manifest with ordered declarations, executable
tool snapshots, hooks and live schema validators. Functions in a binding stay local.

**Loop**: The progression from model calls through tool outcomes to a final result
or a durable wait. A supplied checkpoint is not mutated by a new invocation.

**Step**: One model call together with its middleware, hooks and tool plan.

**Hook**: Developer code the loop calls at a named point: `before` or `after`, scoped to
a `turn` (once per turn) or a `step` (every model call). It returns data that the engine
validates and applies. All capabilities registered at one point run as one host effect.

**Host**: The OSS or Cloud runtime that owns persistence, scheduling,
authentication and provider access around the shared engine.

**Executor**: The customer process that claims host-issued actions and runs the
developer's tool and hook implementations.
_Avoid_: Runtime, when referring to customer code execution.

**SDK client**: The shared application interface for communicating with a host.
Authoring and executor capabilities accompany it in the agents SDK.

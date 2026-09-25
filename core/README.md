# @nylorun/core

Shared portable agent definitions and runtime protocol contracts. No engine,
HTTP client, Node host or SDK dependencies.

- `/define`: `Agent`, `tool`, capabilities, schemas and explicit local bindings.
- `/contracts`: runtime request, event, action and response schemas.
- `/compatibility`: protocol/definition versions and canonical manifest hashing.
- Root: shared contracts and types; no authoring or execution entry points.

Applications normally import `@nylorun/agents`. Hosts and the execution engine
consume core directly.

A built agent's non-enumerable `getBinding()` retains local functions, tool
snapshots, ordered declarations and live output schemas. Only its manifest is
serialized. This works across separate compatible installed copies of core.

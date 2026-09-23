---
"@nylorun/runtime": minor
---

Remove the legacy in-process host. `httpModel`, `HttpModelOptions`, and `ModelEnvironment` are no longer exported from `@nylorun/runtime`, `localSessions` is no longer exported from `@nylorun/runtime/node`, and `modelSelection` is no longer exported from `@nylorun/runtime/configuration`. The internal `Runtime`, `serveAgents`, `openSession`, and AG-UI route are deleted. Host agents with `nylorun dev` / `nylorun serve` and the standalone Runtime.

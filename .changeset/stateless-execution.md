---
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/studio": minor
"@nylorun/create-agent": minor
---

Breaking beta: make Harness run() a direct async state-in/state-out executor with serializable pauses, application scope, cancellation signals, awaited recording, agent-level output schemas, and registered tool families. Runtime owns session scheduling with memory-default or exclusive local storage and directly imports Harness contracts. Isolate Node adapters under runtime/node, stream observations incrementally, and add opt-in bounded token previews with Studio reconciliation. Migrate consumers and deployment guidance together; legacy event records remain archived, not automatically replayed.

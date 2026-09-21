---
"@nylorun/core": patch
"@nylorun/cli": patch
"@nylorun/harness": major
"@nylorun/agents": minor
"@nylorun/runtime": major
"@nylorun/studio": patch
"@nylorun/create-agent": minor
---

Extract shared definitions and contracts into core and local orchestration into
CLI. Harness becomes execution-only; the SDK no longer installs the engine and
Runtime no longer depends on the SDK. Author applications through agents and
install cli for the unchanged nylorun commands. See the package architecture and
migration guide. Cloud installs published packages from npm independently.

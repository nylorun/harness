# @nylorun/cli

## 0.1.1-beta

### Patch Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.
- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [41e613c]
- Updated dependencies [2898d02]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.2.0-beta
  - @nylorun/runtime@0.6.0-beta

## 0.1.0-beta.1

Initial package extraction.

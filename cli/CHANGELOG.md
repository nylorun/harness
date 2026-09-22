# @nylorun/cli

## 0.1.2-beta

### Patch Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.
- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [3a88f51]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.3.0-beta
  - @nylorun/runtime@0.7.0-beta

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

---
"@nylorun/core": minor
"@nylorun/agents": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/studio": patch
"@nylorun/cli": patch
---

Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.

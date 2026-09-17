---
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/studio": minor
---

Breaking beta: expose BuiltAgent as a type-only facade built with Agent(...).use(...).build(), and hide compiled middleware, tool registries, and output validators. AgentBuilder now accepts public agent options instead of internal builder state. createExecutionState requires the original built agent. Remove agent-level executionVersion from AgentOptions, BuiltAgent, and ExecutionState; compatibility stays structural (agentId, outputSchema, plan restore). ExecutionState.version remains 1. A leftover executionVersion key on saved snapshots is ignored.

Model-adapter requests expose immutable ToolDescriptor metadata without executable definitions or validators. Remove the internal BoundMiddleware, StepInput, BoundToolSchema, BoundToolDefinition, and SealedToolCall root type exports. Remove defineToolFamily, ToolFamily, and capability.toolFamilies; register ordinary tools and put discovered identity in arguments or info. Rename the per-run application bag from scope to info (`RunOptions.info`, `request.info`, `context.info`, `Agent<Info>`, Runtime `getInfo` / `SubmitOptions.info`). Existing builder/run usage, type inference, observation payloads, and application-owned resource methods remain supported.

AgentManifest is now a capability catalog: `capabilities` replaces `middleware`, each row publishes `kind` and `hasMiddleware`, declared tools include JSON schemas, and the agent `outputSchema` is included when present. Correlate events by capability id. Studio reads `manifest.capabilities` and still accepts legacy `middleware` documents.

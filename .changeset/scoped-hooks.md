---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/agents": minor
"@nylorun/runtime": minor
"@nylorun/studio": minor
---

Breaking beta: replace `beforeModelCall` / `afterModelCall` with scoped hooks. Register `before("turn" | "step", fn)` and `after("step" | "turn", fn)` on the agent, or `before: { turn, step }` / `after: { step, turn }` on a capability. `before("turn")` runs once per turn and its `Patch` applies to every model call in the turn; the new `after("turn")` returns a `TurnDecision` for the final answer. `after` hooks take one argument and receive `attempt`, and `retry` now retries instead of failing the run. The manifest moves to `manifestSchemaVersion: 4` with `capabilities[].hooks`, and `BeforeModelCallFn`, `AfterModelCallFn` and the `beforeModelCall` / `afterModelCall` action kinds are removed. Every capability registered at a hook point now runs in one `hook` executor action, an expired hook claim is offered again instead of becoming uncertain, and the durable engine version is `hosted-2`. Hook toggles now hide a capability's tools, or one tool of a multi-tool capability, instead of having no effect or failing. Studio lists each capability's hooks with how often they run and labels hook actions. See MIGRATION.md.

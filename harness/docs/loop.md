# How the harness loop is laid out

The public seam is `Agent` → `BuiltAgent.run` → `Session`. Everything below that is the in-memory loop. Open these four files first:

| Layer   | First file                 | Owns                                                                 |
| ------- | -------------------------- | -------------------------------------------------------------------- |
| Build   | `src/build/builder.ts`     | Seal one model, adapters, and middleware into a `BuiltAgent`         |
| Session | `src/session/scheduler.ts` | One session: queue, observe, stream, stop; one active turn at a time |
| Turn    | `src/turn/runner.ts`       | One user turn: a model step, then the tool plan                      |
| Step    | `src/step/run.ts`          | One model call: prefix, context, middleware, project, seal           |

`BuiltAgent.run` constructs a `LiveSession`. The scheduler drives `TurnRunner`, which calls `runStep` and then `ToolPlanRunner`. How a committed step becomes the portable `ModelCall` is in [model-call-projection.md](./model-call-projection.md).

```
AgentBuilder.build
  → BuiltAgent.run
    → LiveSession / SessionScheduler
      → TurnRunner
        → runStep (middleware onion, model, seal)
        → ToolPlanRunner (interaction, preflight, execute)
```

## Glossary

**Prefix.** Middleware-owned, named slots for instructions, visible tools, and the selected model directive. Canonical order, digested, and (in `prefixPolicy: "strict"`) every effective change needs a `reason`. This is what `model.prefix` fingerprints.

**Context.** A parallel ledger, not part of the prefix digest. `request.context.set` writes it; `run({ context })` seeds the reserved host session slot. Default lifetime is this model call only. Do not confuse it with `StepContext` in `src/step/step-context.ts`, which is the mutable lease middleware sees for one step.

**Candidate.** The model’s successful return: ordered `text` / `reasoning` / `tool-call` blocks, plus optional `finishReason`, `usage`, and `evidence`. A string return becomes one text block. Session `final` joins text blocks only.

**Seal.** After the onion returns, `sealStep` turns the reviewed candidate into a tool plan (or a final / tripwire). Retained tool-call ids, names, and arguments cannot change.

**Tripwire.** A structured stop for this step or session. Middleware may return `request.tripwire(...)` instead of calling `next()`. One session’s tripwire does not stop sibling sessions.

**Arrivals.** New input claimed for this step (user message, interrupt, or an interaction reply). They are already on the transcript before invoke, so `projectModelCall` does not append them again.

## Where to add a test

Most tests go through `Agent` from `src/index.ts`. Use that unless you are testing a private helper.

**Public seam** — behavior through `Agent` / `Session`: `session-loop`, `pipeline`, `middleware`, `prompt-prefix`, `context-ledger`, `candidate`, `sealing`, `interaction`, `observation`, `lifecycle`, `conversation-stream`, `isolation`, `schema`, `binding`, `errors`, `public-api`.

**Internal seam** — a private module: `input-queue`, `event-log`, `turn-runner`, `tool-plan-runner`, `project-call`, `utils`.

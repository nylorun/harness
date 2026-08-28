# Harness reference

This page documents the stable machine-readable errors and live observation events exposed by Harness. Error messages are explanatory rather than compatible API; branch on `HarnessError.code` instead. Observers receive events live only and do not replay history.

## Harness error codes

### Adapter

| Code                      | Meaning                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `adapter.invalid-outcome` | A tool adapter returned an outcome outside the Harness tool-result contract. |
| `adapter.not-registered`  | A tool's `executeWith` adapter id is not registered on the built Agent.      |

`AgentBuilder.with(adapter, { maxConcurrentCalls })` validates the optional limit at build time. It must be a positive safe integer; otherwise the build fails with the `adapter.invalid-max-concurrent-calls` diagnostic. An `adapter.started` observation means the call acquired its adapter permit and entered `execute()`; queued calls have no start event.

### Agent

| Code                     | Meaning                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `agent.build-failed`     | Agent construction produced one or more build diagnostics.             |
| `agent.lifecycle-sealed` | A mutating builder operation was attempted after the Agent was sealed. |

### Context

| Code                        | Meaning                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `context.invalid-item`      | Runtime context items are not an array of valid item objects.                 |
| `context.invalid-item-type` | A runtime context item `type` does not match the supported identifier format. |
| `context.invalid-order`     | A context declaration's `order` is not a finite number.                       |
| `context.invalid-reason`    | A context declaration's `reason` is not a non-empty string.                   |
| `context.invalid-slot`      | A context declaration's slot is not a non-empty string.                       |

### Interaction

| Code                              | Meaning                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `interaction.invalid`             | An interaction request is not a valid approval or response shape.     |
| `interaction.missing-resume`      | A pending tool plan did not receive its correlated interaction input. |
| `interaction.uncorrelated-resume` | An interaction input attempted to resume a plan other than its own.   |

### JSON

| Code                  | Meaning                                                   |
| --------------------- | --------------------------------------------------------- |
| `json.invalid-data`   | A value that must be JSON-safe contains unsupported data. |
| `json.invalid-object` | A value that must be a JSON object is not one.            |

### Middleware

| Code                                  | Meaning                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `middleware.next-after-return`        | Middleware called `next()` after its handler had returned.                 |
| `middleware.next-called-twice`        | Middleware called `next()` more than once.                                 |
| `middleware.request-mutators-revoked` | Middleware attempted to mutate its request after its mutation lease ended. |

### Model

| Code                      | Meaning                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `model.candidate-missing` | The model path completed without a candidate to mint.                      |
| `model.invalid-candidate` | The model return value does not satisfy the normalized candidate contract. |
| `model.invalid-directive` | A model directive is malformed or contains unsupported JSON data.          |

### Configuration

| Code                                     | Meaning                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `configuration.duplicate-tool-name`      | More than one visible tool has the same name for a model call.                             |
| `configuration.invalid`                  | Configuration assembly failed without a more specific Harness code.                        |
| `configuration.invalid-instructions`     | A configuration instruction declaration contains a non-string item.                        |
| `configuration.invalid-order`            | A configuration declaration's `order` is not a finite number.                              |
| `configuration.invalid-reason`           | A configuration declaration's `reason` is not a non-empty string.                          |
| `configuration.invalid-slot`             | A configuration declaration's slot is not a non-empty string.                              |
| `configuration.invalid-tools`            | A configuration tool declaration is not an array.                                          |
| `configuration.model-selection-conflict` | `model.select()` conflicts with an already selected model; use `replace()` to override it. |

### Response

| Code                           | Meaning                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `response.invalid-replacement` | Middleware replacement attempted an invalid candidate or changed a retained tool call. |

### Session

| Code                   | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `session.stale-result` | A stopped or superseded Session result was quarantined. |

### Tool

| Code                       | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `tool.invalid-arguments`   | Tool-call arguments failed the declared tool schema.                         |
| `tool.invalid-name`        | A tool name is empty.                                                        |
| `tool.invalid-schema`      | A tool schema is unsupported or does not have an object root.                |
| `tool.invalid-tool-result` | A normalized tool result has an invalid denial, failure, or completed shape. |

## Observe events

Every `ObserveEvent` has a distinct `type`. The TypeScript union groups some variants with the same field shape, but each name in the table below is a separate event. Fields marked optional may be absent.

| Event                         | Required identifiers and payload                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.stopped`             | `reason`                                                                                                                                           |
| `input.received`              | `inputId`, `kind`                                                                                                                                  |
| `input.queued`                | `inputId`                                                                                                                                          |
| `input.rejected`              | `inputId`, `reason`                                                                                                                                |
| `input.cancelled`             | `inputId`, `reason`                                                                                                                                |
| `model.requested`             | `turnId`, `stepId`; optional `inputId`, `requestedModelId`; `attributes.call`, `attributes.configuration`, and `attributes.context`                |
| `model.completed`             | `turnId`, `stepId`; optional `inputId`, `requestedModelId`; `attributes` is the `ModelCandidate`                                                   |
| `step.started`                | `turnId`, `stepId`, `turnNumber`, `stepNumber`; optional `inputId`; `attributes` contains session metadata, arrivals, tool results, and transcript |
| `middleware.entered`          | `turnId`, `stepId`, `middlewareId`; optional `inputId`                                                                                             |
| `middleware.completed`        | `turnId`, `stepId`, `middlewareId`; optional `inputId`                                                                                             |
| `middleware.lease-violation`  | `turnId`, `stepId`, `middlewareId`, `reason`; optional `inputId`                                                                                   |
| `tool.sealed`                 | `turnId`, `stepId`; optional `inputId`; `attributes.executable` and `attributes.immediate` tool results                                            |
| `adapter.preflight.started`   | `turnId`, `stepId`, `adapterId`, `toolName`, `callId`; optional `inputId`, `invocationId`; `attributes.args`                                       |
| `adapter.started`             | `turnId`, `stepId`, `adapterId`, `toolName`, `callId`; optional `inputId`, `invocationId`; `attributes.args`                                       |
| `adapter.preflight.completed` | `turnId`, `stepId`, `adapterId`, `toolName`, `callId`, `outcome`; optional `inputId`, `code`, `attributes` tool result                             |
| `adapter.completed`           | `turnId`, `stepId`, `adapterId`, `toolName`, `callId`, `outcome`; optional `inputId`, `code`, `attributes` tool result                             |
| `turn.completed`              | `turnId`, `stepId`; optional `inputId`; `attributes.output`                                                                                        |
| `interaction.required`        | `turnId`, `stepId`, `interactionId`, `kind`; optional `inputId`, `callId`, `toolName`, `phase`; `attributes.prompt` and optional metadata          |
| `tripwire`                    | `turnId`, `code`, `scope`; optional `stepId`, `inputId`; `attributes.message`                                                                      |

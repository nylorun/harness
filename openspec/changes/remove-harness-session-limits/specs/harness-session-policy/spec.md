## ADDED Requirements

### Requirement: Policy-free native session execution
The native harness SHALL not expose session-limit configuration or apply built-in turn, step, or wall-clock execution limits. A session SHALL continue until it reaches final output, receives an explicit cancellation or close, or receives a model or middleware tripwire.

#### Scenario: Long-lived interaction
- **WHEN** a session pauses for a required interaction and is later given a matching reply
- **THEN** it resumes without an implicit harness timeout

#### Scenario: Explicit cancellation
- **WHEN** an active session input or the session itself is cancelled
- **THEN** the harness aborts active execution and reports cancellation without committing stale work

### Requirement: Middleware execution positions
The harness SHALL provide immutable one-based `turnNumber` and `stepNumber` values on every middleware `StepInput`. The turn number SHALL remain constant across a paused interaction resume, and the next model invocation SHALL use the next step number.

#### Scenario: Application-owned count policy
- **WHEN** middleware observes a configured turn or step position
- **THEN** it can emit a step- or session-scoped tripwire according to application policy

### Requirement: No runtime limits forwarding
The runtime SHALL not expose session limits in its authoring or host option types and SHALL create native sessions without limits configuration.

#### Scenario: Rejected legacy configuration
- **WHEN** a TypeScript consumer supplies `limits` to `Run`, runtime host options, or native session creation
- **THEN** type checking rejects the configuration

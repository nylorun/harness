## ADDED Requirements

### Requirement: Normalized terminal execution outcome
The system SHALL require current-protocol harness executions to resolve with a normalized terminal outcome containing a terminal status and, when available, output, usage, normalized error, and resumable state information.

#### Scenario: Completed execution
- **WHEN** a harness completes an agent invocation successfully
- **THEN** it SHALL return a `completed` outcome and any available output and usage without requiring the runtime to infer success from a missing error

#### Scenario: Cancelled execution
- **WHEN** a cancellation reaches a harness execution before it completes
- **THEN** it SHALL return or reject into a normalized `cancelled` outcome rather than being recorded as an unspecified successful completion

### Requirement: Defined event ownership and coverage
The system SHALL define runtime ownership of session lifecycle events and harness ownership of model, tool, message, and provider failure events, and SHALL prohibit a harness from claiming event coverage it cannot produce.

#### Scenario: Runtime-managed session lifecycle
- **WHEN** a current-protocol harness execution begins and terminates
- **THEN** the runtime SHALL record exactly one ordered session-started and terminal session event

#### Scenario: Adapter event coverage
- **WHEN** an adapter declares token-level streaming or per-call usage support
- **THEN** its execution SHALL emit the corresponding normalized message deltas or model usage events in the documented order

### Requirement: Outcome and event reconciliation
The runtime SHALL reconcile an execution's terminal outcome with its recorded events and SHALL record an adapter protocol failure when they contradict one another.

#### Scenario: Contradictory successful outcome
- **WHEN** an adapter returns a completed outcome after emitting an unrecovered terminal error event
- **THEN** the runtime SHALL mark the run failed with an adapter protocol diagnostic

### Requirement: Capability conformance coverage
The system SHALL provide reusable conformance tests for every supported adapter that verify declared capabilities, cancellation, enforced limits, event order, tool behavior, errors, and terminal outcomes.

#### Scenario: Capability claim regression
- **WHEN** an adapter declares a capability but fails its corresponding conformance fixture
- **THEN** the adapter test suite SHALL fail

## ADDED Requirements

### Requirement: Versioned harness capability declaration
The system SHALL require every current-protocol harness adapter to declare a supported harness protocol version and structured capabilities sufficient to evaluate tool execution, skills, MCP, streaming, model routing, session handling, usage reporting, cancellation, limits, and record-safety behavior.

#### Scenario: Runtime recognizes a current adapter
- **WHEN** a harness carrier is loaded with the current protocol identifier and a complete valid capability declaration
- **THEN** the runtime SHALL accept it as a current-protocol adapter for compatibility evaluation

#### Scenario: Runtime rejects an unversioned adapter without compatibility support
- **WHEN** a harness carrier lacks a recognized protocol identifier and no legacy compatibility mode is enabled
- **THEN** the runtime SHALL reject it before preparation with an actionable protocol diagnostic

### Requirement: Agent requirement derivation
The system SHALL derive execution requirements from the resolved agent definition, discovered tools, skills, MCP configuration, selected execution options, and host policy without requiring a provider SDK dependency.

#### Scenario: Declared tool requirement
- **WHEN** an agent contains a discovered callable tool
- **THEN** its derived requirements SHALL require native or bridged tool execution

#### Scenario: Host routing requirement
- **WHEN** host policy requires Nylo-managed model routing
- **THEN** its derived requirements SHALL require a harness that declares Nylo-managed routing

### Requirement: Deterministic compatibility diagnostics
The system SHALL compare derived requirements and harness capabilities through a shared validator and return typed diagnostics that identify the requirement, the unsupported guarantee, severity, and remediation.

#### Scenario: Unsupported tool target
- **WHEN** an agent requiring tool execution selects a harness that declares no tool support
- **THEN** validation SHALL return an error diagnostic identifying tool execution as incompatible

#### Scenario: Acceptable degradation
- **WHEN** a harness only provides message-level streaming and token-level streaming is not required by the agent or host policy
- **THEN** validation SHALL permit execution and return any applicable non-blocking diagnostic

### Requirement: Build and host admission enforcement
The system SHALL validate compatibility during artifact construction for definition-known requirements and again before host preparation for environment-dependent requirements.

#### Scenario: Build-time hard incompatibility
- **WHEN** a selected harness cannot satisfy a requirement that is fully known from the built agent definition
- **THEN** the build SHALL fail with the compatibility diagnostic

#### Scenario: Host-policy incompatibility
- **WHEN** a built artifact is compatible in isolation but the selected host policy requires a capability the harness lacks
- **THEN** the host SHALL reject the run before invoking adapter preparation or execution

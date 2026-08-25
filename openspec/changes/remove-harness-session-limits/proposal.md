## Why

Session limits are application policy, not a harness concern. Keeping step, turn, and wall-clock limits in the harness creates an unnecessary configuration surface and prevents developers from expressing their own policies through middleware.

## What Changes

- **BREAKING** Remove `SessionLimits` and `SessionOptions.limits` from `@nylorun/harness`.
- **BREAKING** Remove automatic step, turn, and wall-clock timeout enforcement from native harness sessions.
- **BREAKING** Remove `limits` from `@nylorun/runtime` authoring and host options; runtime no longer forwards limits to sessions.
- Add immutable turn and step positions to middleware input so application middleware can enforce count-based policies with `Tripwire`.
- Document that sessions run until final output, an explicit cancellation, or a middleware/model tripwire.

## Capabilities

### New Capabilities

- `harness-session-policy`: Defines policy-free native session execution and the middleware context required for application-owned limits.

### Modified Capabilities

- None.

## Impact

This changes the public APIs of `@nylorun/harness` and `@nylorun/runtime`, their type and behavior tests, runtime authoring reference, and harness documentation. The distinct `@nylorun/agent` adapter-capability limits descriptor is unchanged.

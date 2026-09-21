# Package and application responsibilities

The adopted [package architecture](design/package-architecture.md) is the reference
for dependency direction, public interfaces and migration.

| Concern | Owner |
| --- | --- |
| Agent/tool authoring, manifests, shared validation | Core, exposed to applications by the agents SDK |
| Runtime requests, authentication headers, HTTP errors, SSE observation | Agents SDK client |
| Customer tool/hook functions, external services and business policy | Developer application |
| Claiming actions and invoking customer code | Agents SDK executor |
| Agent loop, execution state and effects | Harness engine |
| Session persistence, scheduling, scoped authorization, providers | OSS runtime or Cloud runtime |
| Local process startup, project registration, configuration prompts | CLI |
| Developer dashboard and trusted local proxy | Studio |
| Generated application shell and tested package pins | Create-agent |

Neither runtime imports the SDK. Both hosts consume harness and core; their
storage and scheduling implementations may differ. SDK clients communicate with
the host over HTTP/SSE. Studio reuses the SDK client and keeps server credentials
in its trusted proxy.

Agent definitions do not own model credentials or run the loop. Local tool
implementations stay in the application executor; only manifests cross the wire.
Host scheduling and the engine determine which actions are issued. The executor
claims scoped work and returns outcomes. External side effects are not guaranteed
exactly once by package structure or reconnection behavior.

Harness remains usable for explicit in-process execution through `/run`. Live
schema validators, middleware and closures cross the core/engine seam through a
local binding; they are not serialized. Core never imports engine internals.

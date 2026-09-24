# Package and application responsibilities

The adopted [package architecture](design/package-architecture.md) is the
reference for dependency direction, public interfaces and migration.

| Concern | Owner |
| --- | --- |
| Definitions, wire schemas, protocol and features, error codes, Admin API, Project-link and build-manifest schemas, id generation | `core` |
| Tenant API requests, SSE, protocol negotiation, connection resolution, saving definitions, derived executor credentials, claiming actions, running tools and hooks | `agents` |
| Admin API requests, safe Tenant creation, connection resolution from local Host settings | `admin` |
| Agent loop, execution state and effects | `harness` |
| Listener, Tenant routing, both surfaces, loopback checks | Runtime Host (`runtime`) |
| Tenant storage, scheduling, principals, vaults, sandboxes, providers, Tenant logs | Tenant Runtime (`runtime`) |
| Installing builds, starting, stopping, upgrading, version policy, `host.json`, `host-credentials.json`, `host-state.json`, locks, log rotation | Launcher |
| Commands, prompts, Project links, `.env` seeding, running the application under a watcher, bootstrap | `cli` |
| Dashboard and trusted proxy | `studio` |
| Babai's experience, bootstrap and keychain storage | Babai |
| Generated application shell and tested package pins | `create-agent` |
| Customer tool/hook functions, external services and business policy | Developer application |

Neither host imports a client package. Both hosts consume harness and core;
their storage and scheduling may differ. Client packages talk to hosts over
HTTP/SSE. Studio reuses `@nylorun/agents` and keeps credentials in its trusted
proxy. The launcher is part of the Runtime build; clients run it as a process
and never import it.

Agent definitions do not own model credentials or run the loop. Local tool
implementations stay in the application executor; only manifests cross the
wire. Derived executor tokens are never stored. External side effects are not
guaranteed exactly once by package structure or reconnection behavior.

Harness remains usable for explicit in-process execution through `/run`. Core
never imports engine internals.

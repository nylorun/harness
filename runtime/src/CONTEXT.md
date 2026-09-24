# Runtime Tenants vocabulary

> **DRAFT (WS-I Wave 1).** Companion design `runtime-tenants.md` was not available
> when this was drafted. Terms follow the Runtime Tenants implementation plan
> (Wave 0 contracts and Host / Tenant / Project link terminology). Finalize in
> Wave 3 against merged behaviour. Every agent uses these terms in code,
> comments, errors and CLI output.

Agent definitions describe capabilities. The harness engine advances execution.
A **Runtime Host** listens once and routes work into isolated **Tenants**. A
developer **Project** attaches through a **Project link**, not by owning the
Host process or its storage.

## Language

**Runtime Host** (or **Host**): The long-lived process that binds one address,
discovers Tenants under its Host root (`NYLORUN_HOME` or `~/.nylorun`), validates
`Nylorun-Protocol` and `Nylorun-Tenant`, serves admin routes, and forwards Tenant
routes to the matching Tenant Runtime. `/health` reports `hostId` and protocol
range; `/ready` is true only after discovery has finished. The Host writes
`host.json`, `host-state.json`, `host-credentials.json` and `runtime.log` — not
a registry of Tenant contents.
_Avoid_: calling the Host a "scope", "project Runtime", or "global Runtime".

**Tenant**: One isolated unit of sessions, principals, vault, sandboxes, plugin
data and logs under `<host root>/tenants/<tenantId>/`. Selected only by the
`Nylorun-Tenant` header (never by a default, query string or body field). Ids
match `tn_` plus 26 Crockford characters. Quarantine leaves other Tenants
running.
_Avoid_: "scope", "database", or "SQLite path" as the name for this unit.

**Tenant Runtime**: The in-process handler for one open Tenant. Created from a
`TenantConfig` (paths, model, sandbox, child env, logger). It authenticates its
own principals and never reads ambient environment, cwd, or home.
_Avoid_: equating "Runtime" alone with a single Project's process.

**Host root**: The absolute directory that holds Host files, the installed
`runtime/<version>/` tree, `tenants/`, and `trash/`. Resolved once from
`NYLORUN_HOME` or `~/.nylorun`.

**Project link**: Project-local `.nylorun/link.json` with
`{ hostUrl, hostId, tenantId }`, plus `.nylorun/credentials.json` (mode 0600)
holding the application key and executor tokens. A fresh clone or second
worktree does not attach until it creates or chooses a link.
_Avoid_: "project scope" and "global scope"; `--global`, `--db`, and
`NYLORUN_SQLITE_PATH` as ways to choose isolation.

**Application principal**: Bearer credential hashed in the Tenant `principals`
table. Authorizes definition and session routes for that Tenant only.
_Avoid_: "server token" / `serverToken` as the public name (legacy API).

**Executor principal**: Bearer credential hashed in the Tenant `executors`
table, scoped to an `agentId`. Never equal to an application principal hash.
_Avoid_: "startup scopes" / `NYLORUN_EXECUTORS_JSON` (removed).

**Admin key**: Host-level secret in `host-credentials.json` (mode 0600).
Authorizes `/v1/admin/*` only; never accepted as a Tenant bearer.

**Protocol**: Wire integer and feature set in `Nylorun-Protocol` /
`HOST_PROTOCOL` (`PROTOCOL_VERSION = 2`, feature `runtime-tenants`). Independent
of package semver. Incompatible clients receive `426` before authentication.
_Avoid_: treating package-version equality as the compatibility check.

## Terms to avoid (appear nowhere in new copy)

| Avoid | Use instead |
| --- | --- |
| project scope / global scope | Host root + Tenant + Project link |
| scopeId (as Host identity) | `hostId` |
| `--global`, `--db`, `NYLORUN_SQLITE_PATH` | Host root / Tenant paths (CLI) |
| `/v1/host/model*` (Tenant routes) | `/v1/tenant/model*` |
| `startRuntime` / `createRuntime` | `startEphemeralRuntime` (tests) / Host entry |
| `NYLORUN_EXECUTORS_JSON` | `PUT /v1/executors` with application credential |

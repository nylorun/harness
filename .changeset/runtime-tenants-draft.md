---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/cli": minor
"@nylorun/studio": minor
---

> **DRAFT (WS-I Wave 1).** Stub for the Runtime Tenants breaking beta. Expand
> and finalize in Wave 3 against merged behaviour. Pre-1.0 packages use `minor`
> for breaking bumps (D1).

**Breaking:** Replace project/global Runtime "scope" with a **Runtime Host** that
serves isolated **Tenants**, selected by `Nylorun-Tenant` and negotiated with
`Nylorun-Protocol` (protocol `2`, feature `runtime-tenants`).

- **core:** `PROTOCOL_VERSION = 2`, `HOST_PROTOCOL`, `TENANT_HEADER`,
  `PROTOCOL_HEADER`, `newTenantId` / `isTenantId`, `checkCompatibility`; health
  schema gains `hostId` + `protocol` (drops `scopeId`); Tenant/admin wire schemas.
- **runtime:** Host process + Tenant module; `/v1/host/model*` → `/v1/tenant/*`;
  remove `startRuntime` / `NYLORUN_EXECUTORS_JSON`; add `startEphemeralRuntime`.
- **agents:** `createClient({ url, key, tenant })`; Transport sends Tenant +
  protocol headers; `/health` compatibility cache; `IncompatibleRuntimeError`.
- **cli:** Host root lifecycle (`runtime up|down|status|logs|restart|run`);
  Project link (`.nylorun/link.json` + `credentials.json`); remove `--global`,
  `--db`, `NYLORUN_SQLITE_PATH`; `tenant` commands; `runtime status --env`.
- **studio:** `startStudio({ …, tenant: { id, name } })`; proxy forwards Tenant
  + protocol headers; UI shows Tenant name/short id.

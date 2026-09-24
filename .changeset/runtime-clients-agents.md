---
"@nylorun/agents": minor
---

**Breaking (pre-1.0 minor):** Tenant API connection and executor credentials for Runtime Clients.

- `resolveConnection()` — options → environment → Project link; sources never mix.
- `createClient()` with no arguments uses `resolveConnection`.
- `connectAgents` application mode: save agents, `PUT /v1/executors` with **derived** tokens (HMAC of application key + Tenant + agent id), connect; tokens are not stored in Project credentials.
- Re-exports `PROTOCOL_FEATURES`, `ERROR_CODES`, `compareVersions`.

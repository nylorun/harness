---
"@nylorun/admin": minor
---

**New package:** Admin API client (`createAdmin`, `createTenant`, list/get/delete Tenants, `status`). Depends only on `@nylorun/core`. Resolves connection from options, then `NYLORUN_ADMIN_URL`/`NYLORUN_ADMIN_KEY`, then local Host settings (`host.json` + `host-credentials.json`).

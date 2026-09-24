---
"@nylorun/admin": minor
---

**New package:** Admin API client for managing clients (CLI, desktop Runtime panel, CI). Exports `createAdmin` with `createTenant`, `listTenants`, `getTenant`, `deleteTenant`, and `status`. Depends only on `@nylorun/core`. Resolves connection from options, then `NYLORUN_ADMIN_URL`/`NYLORUN_ADMIN_KEY`, then local Host settings (`host.json` + `host-credentials.json`). Developer applications do not depend on this package.

---
"@nylorun/runtime": minor
"@nylorun/studio": minor
"@nylorun/core": minor
---

**Runtime Clients and Admin API (supporting packages).**

- **core:** `AdminStatusSchema`, Project-link and build-manifest schemas, `ERROR_CODES`, `admin-status` feature, `newPrincipalId`, `compareVersions`.
- **runtime:** `/v1/admin/status` (alias `/v1/admin/host`), loopback/`Origin`/content-type checks; launcher source under `src/launcher/` shipped inside per-platform **Runtime builds** (`@nylorun/runtime-<platform>-<arch>`, published by release tooling — not workspace packages yet).
- **studio:** `nylorun-studio` binary; connects via `resolveConnection`; waits for `dev`; never calls Admin API or writes `.nylorun/`.

New build packages (same version as `@nylorun/runtime`, platforms `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`) are published in the release run after `@nylorun/runtime` and before `@nylorun/cli`. Draft: Wave 1 docs only; Wave 3 finalizes publish wiring.

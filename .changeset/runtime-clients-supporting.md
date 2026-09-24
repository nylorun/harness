---
"@nylorun/runtime": minor
"@nylorun/studio": minor
"@nylorun/core": minor
---

**Runtime Clients and Admin API (supporting packages).**

- **core:** `AdminStatusSchema`, Project-link and build-manifest schemas, `ERROR_CODES`, `admin-status` feature, `newPrincipalId`, `compareVersions`.
- **runtime:** `/v1/admin/status` (alias `/v1/admin/host`), loopback/`Origin`/content-type checks; launcher source under `src/launcher/` (not in `exports`) shipped inside per-platform **Runtime builds**.
- **studio:** `nylorun-studio` binary; connects via `resolveConnection`; waits for `dev`; never calls Admin API or writes `.nylorun/`.

**New packages (not workspace members):** `@nylorun/runtime-<platform>-<arch>` at the same version as `@nylorun/runtime`, for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, and `win32-x64`. Each build contains Node, `@nylorun/runtime` with production dependencies, and the `nylorun-runtime` launcher. Release tooling packs and publishes them after `@nylorun/runtime` and before `@nylorun/cli` (`scripts/release/runtime-builds.mjs`).

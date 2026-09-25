---
"@nylorun/runtime": minor
"@nylorun/cli": minor
"@nylorun/create-agent": minor
---

**Native Windows is no longer supported; Windows developers use WSL2.** Nylorun runs on macOS and Linux. On native Windows, `nylorun-runtime` refuses with `platform_unsupported`, and `nylorun` and `npm create @nylorun/agent` stop with the same WSL2 guidance. Install Node 24 and `@nylorun/runtime` inside your WSL distribution and keep projects in its Linux filesystem. The Windows-only process handling (`taskkill`, `.cmd` shims, `npm.cmd`) is removed. `nylorun doctor` reports WSL as `Linux (WSL: <distribution>)`.

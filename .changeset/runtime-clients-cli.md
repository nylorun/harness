---
"@nylorun/cli": minor
---

**Breaking (pre-1.0 minor):** CLI reaches the local Runtime only through the launcher inside a Runtime build.

- Dependencies: `@nylorun/agents` and `@nylorun/admin` only (no `@nylorun/runtime`, no `@nylorun/studio`).
- `nylorun runtime …` invokes `nylorun-runtime` (bootstrap when no build is installed); pin via `package.json` `nylorun.runtime`.
- `nylorun dev` runs the application entry under `tsx watch`; creates Tenants through `@nylorun/admin`.
- **Removed:** `nylorun serve`, `nylorun studio`, `--no-studio`, in-process Project runner.
- Install as a **devDependency**; production `start` is `node dist/src/main.js`.

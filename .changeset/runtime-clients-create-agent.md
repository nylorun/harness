---
"@nylorun/create-agent": minor
---

**Breaking (pre-1.0 minor):** Generated starter matches Runtime Clients layout.

- Adds `src/main.ts` with `connectAgents({ agents })`.
- `start` → `node dist/src/main.js`; `studio` → `nylorun-studio`.
- `@nylorun/cli` and `@nylorun/studio` move to `devDependencies`; production depends on `@nylorun/agents` (and `zod`) only.
- `--no-studio` removes Studio without rewriting `dev`.

---
"@nylorun/create-agent": minor
---

Align the starter with Runtime DX v5.6 and Cloud Agents API: document `openSession` / `serveAgents` `{ fetch }`, keep the Hono `/agents` Studio mount, add `NYLORUN_URL` / `NYLORUN_SECRET_KEY` / `NYLORUN_MODE` to `.env.example`, and hard-lock `info` (not `user`) with no `model` on `Agent({})`.

---
"@nylorun/runtime": patch
"@nylorun/create-agent": patch
---

Flatten Runtime agent routes to `/:id/...` and pass matching `basePath` from the Hono mount so discovery, manifests, and AG-UI resolve at `/agents/:id/...` for Studio.

# Runtime hosting scope

This release supports one local Node 24 Runtime process with SQLite, a connected customer executor, and optional local Studio.

```sh
npm run build
npm start
```

Compiled start loads `dist/agents/index.js`, starts Runtime and the SDK executor, and binds loopback on port 8787 (`PORT` override). It does not start Studio or watch files. Keep `.nylorun/` private and persistent across ordinary restarts; it contains local credentials and SQLite. Configure providers before startup with `npm run configure`.

For explicit standalone host configuration, see [Runtime](runtime/README.md). Do not reuse the old Hono, Worker, Vercel, or exported-fetch recipes with the new Runtime. They described the previous host and are not supported deployment paths for this beta.

Remote ingress, TLS, containers, replicas, hosted customer executors, backups/migrations, crash recovery qualification, and deployment automation are deferred. Local build and smoke results do not establish those deployment guarantees.

# Runtime hosting scope

This release supports one local Node 24 Runtime process with SQLite, a connected customer executor, and optional local Studio.

```sh
npm run build
npm start
```

`npm start` runs `nylorun serve`, which loads `dist/agents/index.js`, attaches to the local Runtime on loopback port 8787 (`--port` or `PORT` override) and connects the SDK executor. It does not start Studio or watch files. If no Runtime is listening it starts one in the background and leaves it running. For a container or any supervised deployment, start the host explicitly — `nylorun up`, or run `@nylorun/runtime/server` as its own process — and pass `nylorun serve --no-autostart` so a missing Runtime fails the process instead of spawning an unsupervised one. Keep `.nylorun/` private and persistent across ordinary restarts; it contains local credentials, the model provider vault, SQLite, and the Runtime log. The first run stores the provider credential in that vault. `nylorun down` stops the Runtime and keeps all of it.

For explicit standalone host configuration, see [Runtime](runtime/README.md). Do not reuse the old Hono, Worker, Vercel, or exported-fetch recipes with the new Runtime. They described the previous host and are not supported deployment paths for this beta.

Remote ingress, TLS, containers, replicas, hosted customer executors, backups/migrations, crash recovery qualification, and deployment automation are deferred. Local build and smoke results do not establish those deployment guarantees.

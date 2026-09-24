# Runtime Host deployment

> **DRAFT (WS-I Wave 1).** Host + Tenant layout. Finalize in Wave 3.

This release supports one local Node 24 **Runtime Host** process with SQLite
**Tenants**, connected customer executors, and optional local Studio.

```sh
npm run build
npm start
```

`npm start` runs `nylorun serve`, which loads `dist/agents/index.js`, attaches
to the Runtime Host on loopback (default port 8787; `--port` override) and
connects the SDK executor for the linked Tenant. It does not start Studio or
watch files. If no Host is listening it starts one in the background and leaves
it running. For a container or any supervised deployment, start the Host
explicitly — `nylorun runtime up`, or run `@nylorun/runtime/server` as its own
process under a dedicated Host root — and pass `nylorun serve --no-autostart` so
a missing Host fails the process instead of spawning an unsupervised one.

Keep the **Host root** (`NYLORUN_HOME` or `~/.nylorun`) private and persistent
across ordinary restarts: `host.json`, admin credentials, installed runtimes,
and every Tenant directory. Keep each Project's `.nylorun/link.json` and
`credentials.json` private as well. The first Project run stores the provider
credential in that Tenant's vault. `nylorun runtime down` stops the Host and
keeps Host config and Tenants.

For explicit standalone Host configuration, see [Runtime](runtime/README.md).
Do not reuse the old Hono, Worker, Vercel, or exported-fetch recipes with the
new Runtime. They described the previous host and are not supported deployment
paths for this beta.

Remote ingress, TLS, containers, replicas, hosted customer executors,
backups/migrations, crash recovery qualification, and deployment automation are
deferred. Local build and smoke results do not establish those deployment
guarantees.

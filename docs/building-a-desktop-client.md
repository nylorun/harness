# Building a desktop client

Draft for Runtime Clients and Admin API version 1. Babai (outside this
repository) is the reference experience. This document specifies the contracts
a desktop app must use — not Babai's UI or packaging.

Vocabulary: [runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

## Roles

| Role | Uses |
| --- | --- |
| Own agents | `@nylorun/agents` with one Tenant per OS user (or product policy) |
| Runtime panel | `@nylorun/admin` (local Host settings) and the launcher |

## Main-process rule

All Runtime HTTP calls and all launcher processes must run from the desktop
**main process** (for example Electron main), never from a renderer.

The OSS Host rejects any request with an `Origin` header (`403 origin_rejected`)
and applies loopback `Host` checks on every route. Browser `fetch` sends
`Origin`; Node's `fetch` does not. Studio's proxy already strips `Origin`
upstream.

## Pin and store

- Pin the Runtime build version the app is tested with.
- Store the Tenant id and application key in the OS keychain (Electron
  `safeStorage`, or equivalent). Never bundle a Runtime build in version 1.
- Do not start the Runtime at login; start it with `up` when the app needs it.

## Resolve the newest launcher

List `<home>/runtime/*` (default `NYLORUN_HOME` or `~/.nylorun`). Skip names
starting with `.`. Keep directories whose `manifest.json` matches this platform
and architecture. Pick the highest `runtimeVersion` by semver. The executable
is `<dir>/bin/nylorun-runtime` (`.cmd` on Windows).

If none exists, **bootstrap** once (below), then use that install's launcher.

## Bootstrap (when no build is installed)

1. Fetch
   `<registry>/@nylorun%2fruntime-<platform>-<arch>/<pinned version>` and read
   `dist.tarball` and `dist.integrity`. Registry defaults to
   `https://registry.npmjs.org` (`NYLORUN_REGISTRY` overrides).
2. Download into `<home>/runtime/.download-<random>/`, verify the SRI
   integrity, and extract, stripping `package/`.
3. Run
   `<extracted>/bin/nylorun-runtime install <version> --from <extracted> --json`.
4. Delete `.download-<random>/` whatever the result.

Write nothing else. A failed download must leave no files outside
`.download-*`. The CLI's bootstrap is the reference; desktop apps implement the
same four steps.

## Launcher commands

Global options: `--home <dir>`, `--json`.

| Command | Result (JSON `type: "result"`) |
| --- | --- |
| `install <version> [--from <dir>]` | `{ version, path, installed }` |
| `up [--version <v>] [--port <n>]` | `{ url, hostId, pid, version, started }` |
| `down [--wait [--timeout <s>]] [--force]` | `{ stopped }` |
| `restart [--version <v>] [--allow-downgrade] [--wait \| --force]` | same as `up` |
| `status` | `{ launcherProtocol, home, state, url?, hostId?, pid?, version?, runtimeVersion?, installed }` — `state`: `running` \| `stopped` \| `absent` \| `unresponsive` \| `foreign-port` |
| `logs [--lines <n>] [--follow] [--tenant <id> \| --all]` | log lines as events |
| `run [--port <n>]` | foreground Host; prints `up` result once ready |

With `--json`, stdout is newline-delimited JSON:

```json
{"type":"progress","phase":"download","received":1048576,"total":41943040}
{"type":"result","url":"http://127.0.0.1:8787","hostId":"host_…","pid":123,"version":"0.9.0-beta","started":true}
{"type":"error","code":"integrity_mismatch","message":"…","remedy":"…"}
{"type":"log","source":"host","line":"…"}
```

Exit codes: `0` success, `1` operation failed (error object present), `2` usage
error. Every error carries a `remedy`. Command names, flags and JSON fields are
**launcher protocol 1** (`launcherProtocol: 1` on `status`).

Important behaviors:

- `up` never restarts a running Host and never starts below
  `host.json.runtimeVersion`.
- Concurrent `install` / `up` from two processes produce one install and one
  Host.
- `down` without flags refuses when sessions or executors are active
  (`active_work`); use `--wait` or `--force`.

## `@nylorun/admin`

```ts
import { createAdmin } from "@nylorun/admin";

const admin = createAdmin(); // options → env → local Host (host.json + host-credentials.json)
await admin.status();
const { tenant, applicationKey } = await admin.createTenant({ name: "MyApp" });
await admin.listTenants();
await admin.getTenant(tenant.id);
await admin.deleteTenant(tenant.id); // after confirm
```

Connection sources never mix. A group- or world-readable
`host-credentials.json` is rejected on POSIX. First use checks `/health` and
throws `incompatible_host` on mismatch.

## First-launch sequence (reference)

1. If no Tenant id/key in the keychain and no launcher installed → show
   progress, run bootstrap.
2. `up --version <pin> --json`.
3. If no stored Tenant → `admin.createTenant({ name })`, store id and key.
4. `connectAgents` / `createClient` with `{ url, tenant, key }` from the
   `up` result and keychain.

After the Runtime starts the first time, tell the user once that it keeps
running after quit and can be stopped from Settings. Quitting the app leaves
the Runtime up so CLI Projects can share it.

## Everyday use

- Every launch runs `up --version <pin>` (no-op when already running).
- When `status.version` is below the pin, offer `restart --version <pin>`
  (ask before `--wait` if other Tenants are active).
- Runtime panel: `admin.status()` / launcher `status` when stopped;
  `listTenants` / `getTenant`; Start · Stop · Restart · Delete · Logs via the
  launcher commands above.

## Failure cases

| Situation | Response |
| --- | --- |
| Tenant deleted elsewhere | Tenant API opaque `404`; `admin.getTenant` confirms gone; offer create |
| Tenant quarantined | Show repair text from `admin.getTenant` |
| Runtime too new for this app | `incompatible_host`: update the app |
| Keychain entry lost | Create a new Tenant; old one remains until deleted |
| `host_schema_newer` / `upgrade_failed` | Show launcher message and remedy; leave Runtime as left |
| Port 8787 taken | Launcher persists another port; `admin` reads `host.json` |

## Sharing the machine with the CLI

One Runtime per machine. Whichever client runs `up` first starts it; the other
reuses it. Each sees the other's Tenants. A newer CLI pin does not restart a
Runtime the desktop app is using without `--wait` or `--force`.

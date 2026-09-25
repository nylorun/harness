# Building a desktop client

Adopted for Runtime Clients and Admin API version 1. Babai (outside this
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

## Prerequisites

The app's user installs the Runtime once, as a developer does; the app never
downloads Node or the Runtime (see
[runtime distribution](design/runtime-distribution.md)):

```sh
node --version                            # 24 or newer
npm install --global @nylorun/runtime     # provides nylorun-runtime
```

When a prerequisite is missing, show these two commands and stop. Desktop apps
for people without Node are out of scope for version 1.

## Pin and store

- Record the Runtime version the app is tested with, and name it in the
  install command it shows.
- Store the Tenant id and application key in the OS keychain (Electron
  `safeStorage`, or equivalent).
- Do not start the Runtime at login; start it with `up` when the app needs it.

## Find the launcher

Search `PATH` for `nylorun-runtime` (`nylorun-runtime.cmd` on Windows). npm
links it to `@nylorun/runtime/dist/launcher/main.js`: a symlink on macOS and
Linux, a `.cmd` shim beside `node_modules/@nylorun/runtime` on Windows. Run
that script with Node rather than the `.cmd` shim, which Node spawns only
through a shell.

Then run `nylorun-runtime --json version` and check
`launcherProtocol === 1` and that `protocol.min <= 2 <= protocol.max`. If not,
show the install command for the version the app was tested with.

## Launcher commands

Global options: `--home <dir>`, `--json`.

| Command | Result (JSON `type: "result"`) |
| --- | --- |
| `version` (also `--version`) | `{ runtimeVersion, launcherProtocol, protocol, node }` |
| `up [--port <n>] [--allow-downgrade]` | `{ url, hostId, pid, version, started }` |
| `down [--wait [--timeout <s>]] [--force]` | `{ stopped }` |
| `restart [--port <n>] [--allow-downgrade] [--wait \| --force]` | same as `up` |
| `status` | `{ launcherProtocol, home, state, url?, hostId?, pid?, version?, runtimeVersion?, launcherVersion }` — `state`: `running` \| `stopped` \| `absent` \| `unresponsive` \| `foreign-port`; `runtimeVersion` is the version that last ran the Host, `launcherVersion` the installed one |
| `logs [--lines <n>] [--follow] [--tenant <id> \| --all]` | log lines as events |
| `run [--port <n>]` | foreground Host; prints `up` result once ready |

With `--json`, stdout is newline-delimited JSON:

```json
{"type":"progress","phase":"start"}
{"type":"result","url":"http://127.0.0.1:8787","hostId":"host_…","pid":123,"version":"0.9.0-beta","started":true}
{"type":"error","code":"downgrade_refused","message":"…","remedy":"…"}
{"type":"log","source":"host","line":"…"}
```

Exit codes: `0` success, `1` operation failed (error object present), `2` usage
error. Every error carries a `remedy`. Command names, flags and JSON fields are
**launcher protocol 1** (`launcherProtocol: 1` on `status`).

Important behaviors:

- `up` never restarts a running Host and never starts a Runtime older than
  `host.json.runtimeVersion` without `--allow-downgrade`.
- The Host runs on the same Node as the launcher, from the installed package.
  `restart` moves it onto the currently installed Runtime.
- Concurrent `up` from two processes starts one Host.
- The launcher refuses Node older than 24 (`platform_unsupported`).
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

1. If `nylorun-runtime` is not on PATH, or `version` reports an incompatible
   protocol → show the prerequisites and stop.
2. `up --json`.
3. If no stored Tenant → `admin.createTenant({ name })`, store id and key.
4. `connectAgents` / `createClient` with `{ url, tenant, key }` from the
   `up` result and keychain.

After the Runtime starts the first time, tell the user once that it keeps
running after quit and can be stopped from Settings. Quitting the app leaves
the Runtime up so CLI Projects can share it.

## Everyday use

- Every launch runs `up` (no-op when already running).
- When `status.version` is below the version the app was tested with, show the
  install command, then offer `restart` (ask before `--wait` if other Tenants
  are active).
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
reuses it. Each sees the other's Tenants. Installing a newer Runtime does not
restart a Host the desktop app is using; `restart` needs `--wait` or `--force`
while work is active.

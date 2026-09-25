# @nylorun/cli

## 0.3.0-beta

### Minor Changes

- c49efed: **Breaking (pre-1.0 minor):** CLI reaches the local Runtime only through the launcher inside a Runtime build.

  - Dependencies: `@nylorun/agents` and `@nylorun/admin` only (no `@nylorun/runtime`, no `@nylorun/studio`).
  - `nylorun runtime …` invokes `nylorun-runtime` (bootstrap when no build is installed); pin via `package.json` `nylorun.runtime`.
  - `nylorun dev` runs the application entry under `tsx watch`; creates Tenants through `@nylorun/admin`.
  - **Removed:** `nylorun serve`, `nylorun studio`, `--no-studio`, in-process Project runner.
  - Install as a **devDependency**; production `start` is `node dist/src/main.js`.

- c49efed: **Breaking (pre-1.0 minor):** Replace a single SQLite Runtime per Project or home directory with a **Runtime Host** that serves isolated **Tenants**, selected by `Nylorun-Tenant` and negotiated with `Nylorun-Protocol` (protocol `2`, feature `runtime-tenants`). Vocabulary: Host root + Tenant + Project link.

  - **core:** `PROTOCOL_VERSION = 2`, `HOST_PROTOCOL`, `TENANT_HEADER`, `PROTOCOL_HEADER`, `newTenantId` / `isTenantId`, `checkCompatibility`; health schema gains `hostId` + `protocol` (`service: "nylorun-runtime"`); Tenant/admin wire schemas; Tenant model routes under `/v1/tenant/*`.
  - **runtime:** Host process + Tenant module; Tenant model routes under `/v1/tenant/*`; `startEphemeralRuntime` for tests/embeds; executors via `PUT /v1/executors`; sandbox prefix `nylorun-<tenant-id>-`.
  - **agents:** `createClient({ url, key, tenant })`; Transport sends Tenant + protocol headers; `/health` compatibility cache; `IncompatibleRuntimeError` with upgrade remedies.
  - **cli:** Host root lifecycle (`runtime up|down|status|logs|restart|run`); Project link (`.nylorun/link.json` + `credentials.json`); `tenant` commands; `runtime status --env` exports `NYLORUN_RUNTIME_URL`, `NYLORUN_SERVER_KEY`, `NYLORUN_TENANT`; removed Project/home SQLite selectors.
  - **studio:** `startStudio({ …, tenant: { id, name } })`; proxy forwards Tenant + protocol headers; UI shows Tenant name/short id.

### Patch Changes

- Pin agents to the tested release.
- Pin admin to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.6.0-beta
  - @nylorun/admin@0.2.0-beta

## 0.2.1-beta

### Patch Changes

- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [1cd7dc7]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.5.0-beta
  - @nylorun/runtime@0.9.0-beta

## 0.2.0-beta

### Minor Changes

- b8d822a: Remove `nylorun start`. The compiled agent process is now `nylorun serve [entry]`, with the
  same `dist/agents/index.js` default, and generated projects must change `scripts.start` to
  `nylorun serve`. The local Runtime becomes a persistent process of its own under
  `nylorun runtime start|stop|status|logs`, with `nylorun up` and `nylorun down` as aliases.
  `dev` and `serve` attach to that Runtime, start one when nothing is listening, and leave it
  running, so a watch restart re-registers agents and reconnects executors instead of
  destroying in-flight sessions; `--no-autostart` fails instead and is what continuous
  integration should use. Scope is per project by default in `.nylorun/`, created on first use,
  with `--global` and `NYLORUN_HOME` for a shared Runtime in the home directory. Commands
  report a resolved scope in every message, accept `--port` and `--db` alongside the existing
  environment variables, expose `nylorun runtime status --output json`, and use documented exit
  codes for usage errors, port conflicts, version skew, refused autostart and failed starts.
- b8d822a: Add `sandbox()`: one `.use(sandbox())` gives an agent Runtime-executed `bash`, `read`, `write`, `edit`, `grep` and `glob` tools on an isolated machine with a persistent `/workspace`. The Runtime selects a microsandbox microVM where available, otherwise an in-process virtual shell, enforces deny-by-default egress presets, owns sandbox lifecycle, and reports its choice through `GET /v1/host/sandbox`, the `nylorun dev` banner and `nylorun doctor sandbox`.

### Patch Changes

- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.4.0-beta
  - @nylorun/runtime@0.8.0-beta

## 0.1.2-beta

### Patch Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.
- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [3a88f51]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.3.0-beta
  - @nylorun/runtime@0.7.0-beta

## 0.1.1-beta

### Patch Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.
- Pin agents to the tested release.
- Pin runtime to the tested release.
- Updated dependencies [41e613c]
- Updated dependencies [2898d02]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @nylorun/agents@0.2.0-beta
  - @nylorun/runtime@0.6.0-beta

## 0.1.0-beta.1

Initial package extraction.

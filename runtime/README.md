# @nylorun/runtime

Portable agent hosting, pi-ai model providers, and the `nylorun` CLI. Runtime has no Harness dependency. Studio is loaded from the application only when requested.

```ts
import { defineRuntime } from "@nylorun/runtime";
import { agents } from "./agent/registry.js";
export default defineRuntime({ agents });
```

Applications install their engine and Runtime directly, with Studio as a development dependency. An agent may bind Runtime's `piModel()` through its engine's model interface. `piModel({ media })` uses the explicitly supplied media adapter to resolve opaque image references. It never fetches arbitrary media URLs.

## Commands

Run from the directory containing `nylorun.config.ts`:

- `nylorun dev [--no-studio] [--no-open] [--port 4111] [--host 127.0.0.1] [--allowed-hosts a,b]`
- `nylorun studio --agent-url http://127.0.0.1:4111 [--port 3000] [--no-open]`
- `nylorun configure`
- `nylorun inspect`
- `nylorun build`
- `nylorun start [--port 4111] [--host 127.0.0.1] [--allowed-hosts a,b]`

`PORT`, `HOST` and `ALLOWED_HOSTS` environment variables supply the same settings. By default the host binds to loopback and answers only to `localhost`, `127.0.0.1` and `[::1]` on the chosen port, so changing `--port` needs no other setup and Studio connects to whatever address is printed. To publish, bind with `--host 0.0.0.0` (every Host header is then served) or keep the loopback bind behind a reverse proxy and list the public names in `--allowed-hosts`; `*` accepts any Host header. Development retains existing sessions across reloads; new sessions use the latest definitions. A failed reload leaves the previous runtime active. Studio attachment does not start or own the remote runtime.

Build emits `dist/nylorun.config.js` and application assets under `dist/agent/`. Deploy `dist/`, your package manifest and lockfile, installed production dependencies, and private configuration. Production startup does not import Studio. Use `projectAsset("agent/skills/catalog")` for assets that must resolve in source and built deployments.

## Configuration and adapters

The default host uses in-memory history and text input. Add `persistence: localJsonl()` and `media: localMedia()` explicitly for local storage under `.data/sessions` and `.data/media`. Share the same media adapter with `piModel({ media })` and domain tools. Persistence preserves history across restarts; archived sessions cannot resume execution and require a new conversation.

The creator runs `nylorun configure` after installation and before development unless `--skip-config` is passed. Standalone configuration also supports scripted input. EOF fails setup; Ctrl-C/SIGTERM cancels prompts and authentication with exit status 130/143. A cancelled setup does not proceed to development.

`nylorun configure` stores provider credentials in `.env/auth.json` and selection in `config/model.json`. Agents can be imported before setup; provider authentication is resolved when the model is called. Optional integration environment variables are loaded from `.env/integrations.env`. Existing flat `.env` files must be relocated before creating the vault; never commit credentials. Image-editing and external coding integrations may use their own credentials independently.

## Portable contracts

`RuntimeAgent` supplies `id`, `name`, a matching `manifest`, and `run({ id })`. Its session supplies `input`, `stream`, `observe`, and `stop`. An input handle's `completed` promise settles after that input's execution or pause, with ordered lifecycle events and a status. Runtime uses completion events for terminal output and interactions, and observation events for optional diagnostics. Engines need not emit model/tool diagnostics or middleware metadata. Runtime records input before execution and flushes persistence before returning an HTTP reply. `stop()` releases session resources; optional agent `close()` runs after session shutdown. Shutdown is idempotent.

`RuntimeModelAdapter` accepts ordered prompt items, tools, model controls, opaque media references, and an abort signal, returning portable text/reasoning/tool-call outputs. It has no engine import. Integration tests in the creator check assignment in both directions with Harness without casts. Runtime's own tests use an independent engine.

Discovery and manifest documents use protocol version 2. The agent's manifest is under `manifest`; no engine-branded envelope is required. Existing agent-scoped HTTP endpoint paths remain unchanged. Studio also understands legacy version-1 `harness.manifest` documents.

Repository development: [contributing](../CONTRIBUTING.md). Package publication: [releasing](../RELEASING.md).

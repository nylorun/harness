# Harness examples

A public, direct-Harness multi-agent starter. There is no generator or hidden runtime: each
`agents/*/agent.ts` builds one `Agent({ id, name, instructions }).use(...).with(adapter).build()`
instance. This project owns its
Hono host, provider adapter, local persistence, and Studio protocol implementation.

## Requirements and install

Use Node 22.19 or newer. Clone Harness, install the root workspace, then install this example:

```sh
git clone https://github.com/nylorun/harness.git
cd harness
npm ci
cd examples
npm install
cp .env.example .env
```

The example uses the checked-out `../harness` package, so edits to Harness are picked up
locally. It installs the exact published Studio prerelease from npm.

## Configure a model provider

The agent server reads its configuration only from the process environment or `.env`; Studio never
receives credentials. Set `NYLO_PROVIDER` and `NYLO_MODEL` in `.env`, then provide the credential
that pi-ai expects for that provider in your shell or `.env`.

For OpenAI, for example:

```dotenv
NYLO_PROVIDER=openai
NYLO_MODEL=gpt-4.1-mini
OPENAI_API_KEY=your-key-here
```

For a local Ollama server, including the small model used while developing this example:

```dotenv
NYLO_PROVIDER=ollama
NYLO_MODEL=gemma3:270m
NYLO_BASE_URL=http://127.0.0.1:11434/v1
```

For vLLM, LM Studio, or another OpenAI-compatible endpoint, set `NYLO_BASE_URL` too. If that
endpoint needs a key, set `NYLO_API_KEY_ENV` to the name of the environment variable holding it:

```dotenv
NYLO_PROVIDER=my-openai-compatible-server
NYLO_MODEL=my-model
NYLO_BASE_URL=http://127.0.0.1:8000/v1
NYLO_API_KEY_ENV=MY_SERVER_API_KEY
```

For a pi-ai provider definition that has not shipped yet, set `NYLO_PROVIDER_MODULE` to an ignored
local module. That module exports `register(models)` and adds its provider to pi-ai's model
registry. This hook runs in the server only; its path and values are not included in manifests,
events, or records.

## Run with Studio

Build once, then start the example and Studio together:

```sh
npm run build
npm run studio
```

The Hono server listens at `http://127.0.0.1:4111`. Studio prints a URL such as
`http://localhost:<port>`; open that URL in your browser. Pick an agent from the selector,
send a message, and inspect the manifest, session, chat activity, and canonical events.

For server development, run `npm run dev` in one terminal. Vite reloads changed agent, capability,
service, skill, and server modules for new sessions. A session already in flight stays attached to
the agent definition that created it. Then run `npm run studio` in another terminal; it attaches to
the server already listening on port 4111 instead of starting a second copy.

## Try every agent in Studio

| Select this agent | Send this message | What to verify |
| --- | --- | --- |
| **In-process tools** | `Calculate 19 * 7, then save the result in a note named math.` | A calculator call/result appears. Studio asks for approval before `write_note`; approve it, then confirm the final response and JSONL record. |
| **Local MCP** | `Use the MCP tool to add 12 and 30.` | The bundled stdio MCP server is discovered, called, and closed cleanly when the server stops. |
| **Docker workspace** | `Create hello.txt containing hello, list the workspace, then read it.` | After Docker preflight passes, see isolated filesystem and shell tool activity. |
| **Docker skills** | `Load the safe shell skill, then show the current workspace.` | `load_skill` adds the local Markdown procedure for this session and Docker executes it. |
| **Docker code mode** | `Create a tiny JavaScript module and test it.` | Review the proposed write, approve it, then inspect file and test-tool results. |

Model behavior varies, particularly for very small local models. If a model answers directly rather
than selecting a tool, try a more explicit request such as “you must use the calculator tool.” The
server still exposes every tool and lifecycle event truthfully; it does not invent tool calls.

Studio discovers these agents through `GET /v1/agents`, then reads each generated
`/agents/:id/manifest.json`. The agent-scoped endpoints are:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/agents` | Agent IDs and manifest URLs |
| `GET /agents/:id/manifest.json` | One direct-Harness agent manifest |
| `POST /agents/:id/v1/ag-ui` | AG-UI SSE run stream |
| `GET/POST /agents/:id/v1/sessions/...` | Sessions, canonical events, history, and approvals |

## Docker agents

Docker is lazy and opt-in: all five agents remain visible if it is unavailable. Before trying a
Docker-backed agent, run:

```sh
npm run docker:preflight
```

Containers have no network, a read-only root filesystem, dropped capabilities, no-new-privileges,
non-root execution, and CPU, memory, PID, output, and time limits. The only mount is an isolated
session workspace; Docker never receives your repository or home directory.

## Learn from the code

Start with [the in-process agent](./agents/inprocess-tools/agent.ts): it composes a model selection,
tools, and candidate review directly. Its capability modules are deliberately small:

- [calculator](./capabilities/calculator.ts) is a static tool declaration.
- [notes](./capabilities/notes.ts) uses an ordinary JSONL service.
- [review](./capabilities/review.ts) requires approval before a write candidate is accepted.
- [sandbox](./capabilities/sandbox.ts) and [skills](./capabilities/skills.ts) show session-scoped
  capability state around a Docker service.

For the underlying agent and capability model, read the concise [Harness README](../harness/README.md).
For the browser-side protocol, read the [Studio README](../studio/README.md).

## Records, secrets, and cleanup

Notes and canonical session records are written below `.data/`, grouped by agent and session. They
are ignored by Git. Known environment secrets and credential-shaped fields are redacted before
records or HTTP responses are created; request headers and raw provider payloads are never exposed.

Stop the processes with `Ctrl-C`. To start from a clean local history, remove `.data/`:

```sh
rm -rf .data
```

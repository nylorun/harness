# Harness → Runtime → Studio manual test plan

This plan validates the current integration with a real local Ollama model. Model mocks, replay
adapters, and provider stubs are not valid evidence for this plan.

## Test fixtures

- `tmp/ollama-simple`: generated agent, direct real-model run, and six-session isolation script.
- `tmp/ollama-tools`: generated agent with one local tool and a real model-driven tool loop.
- `tmp/ollama-approval`: generated agent with approval middleware and a resumable interaction script.
- Model: `local/gemma4:e2b-mlx` (replace the tag only if `ollama list` proves it differs).

Every generated definition must use the deferred factory shape:

```ts
import { Agent } from "@nylorun/harness";
import { Run } from "@nylorun/runtime";

export default Run((model, directive) => Agent(model, directive), {
  name: "sample",
  model: "local/gemma4:e2b-mlx",
});
```

## 1. Environment and packages

```sh
node --version
npm --version
ollama list
curl -sS http://127.0.0.1:11434/api/tags

npm run check --workspace @nylorun/harness
npm run check --workspace @nylorun/runtime
npm run check --workspace @nylorun/create-agent
npm run check --workspace @nylorun/studio
npm run check
```

Pass when the installed model is visible and every package plus the root check succeeds. Studio's
check includes its loopback and Playwright tests.

## 2. Generator and developer syntax

Generate a disposable project with `@nylorun/create-agent`, model
`local/gemma4:e2b-mlx`, and the local package specs. Inspect these facts:

- `agent/agent.ts` contains the two-import deferred Harness factory above.
- `.env.example` pins `http://127.0.0.1:11434/v1` and has no API key.
- The Harness dependency is `^0.4.0-rc.1`.
- `npm run check` and `npm run build` succeed after install.
- `dist/nylo.manifest.json` identifies `@nylorun/harness` and its capability list.

## 3. Direct real-Ollama runs

From the repository root:

```sh
node tmp/ollama-simple/scripts/single.mjs
node tmp/ollama-tools/scripts/tool.mjs
node tmp/ollama-simple/scripts/parallel.mjs
```

Pass criteria:

- Simple: `model.call` reports `gemma4:e2b-mlx`, `private-or-local-endpoint`, and a `final` event.
- Tool: logs show `tool.sealed`, `adapter.started`, `adapter.completed`, and
  `TOOL RESULT: resolved-BLUE-42`.
- Parallel: all six unique sentinels return only in their own result, and all event envelopes keep
  their own Session ID.

## 4. REST, SSE, continuation, and records

Start the generated simple agent:

```sh
cd tmp/ollama-simple
NYLO_MODEL_GATEWAY_URL=http://127.0.0.1:11434/v1 \
NYLO_MODEL_GATEWAY_PROTOCOL=openai-chat-completions \
NYLO_MODEL_GATEWAY_ACCESS_MODE=private-or-local-endpoint \
node ../../studio/dist/cli.js serve --port 4111
```

In another terminal:

```sh
CREATE=$(curl -sS -X POST http://127.0.0.1:4111/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"agent_id":"ollama-simple","message":"Current token: [rest-one]"}')
SESSION_ID=$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(x.session_id)' "$CREATE")
curl -N "http://127.0.0.1:4111/v1/sessions/$SESSION_ID/stream"
curl -sS -X POST "http://127.0.0.1:4111/v1/sessions/$SESSION_ID" \
  -H 'content-type: application/json' -d '{"message":"Current token: [rest-two]"}'
curl -sS "http://127.0.0.1:4111/v1/ag-ui/sessions/$SESSION_ID"
curl -sS "http://127.0.0.1:4111/v1/sessions/$SESSION_ID/events?after=0&limit=1000"
```

Pass when cursors are monotonic, both turns occur in one Harness Session, history contains both user
messages and finals, and `.nylo/runs/<session-id>.jsonl` is readable after shutdown.

## 5. Studio with the real agent

```sh
cd tmp/ollama-simple
NYLO_MODEL_GATEWAY_URL=http://127.0.0.1:11434/v1 \
NYLO_MODEL_GATEWAY_PROTOCOL=openai-chat-completions \
NYLO_MODEL_GATEWAY_ACCESS_MODE=private-or-local-endpoint \
node ../../studio/dist/cli.js dev --studio --no-open --port 4111
```

Open the printed `http://nylo.run.localhost:<port>` URL.

1. Confirm the dashboard shows `ollama-simple`, `local/gemma4:e2b-mlx`,
   `@nylorun/harness`, version `0.4.0-rc.1`, and the bound Harness model,
   middleware, and adapter IDs.
2. Create a Session and send `Current token: [studio-one]`.
3. Confirm the assistant returns the sentinel through the AG-UI chat.
4. Send `Current token: [studio-two]` in the same Session and confirm the new final.
5. Open Events and confirm sequenced `harness.observe`, `model.call`, `final`, and
   `session.run.ended` rows.
6. Repeat with `tmp/ollama-tools`; confirm the Tools card lists `lookup-code` and the Studio response
   contains `resolved-BLUE-42`.
7. Repeat with `tmp/ollama-approval`; confirm Studio renders the Harness interaction prompt and that
   approving it resumes the same Session and produces `PUBLISHED: studio-approval`.

## Results

Use this exact table for the final report.

| Step | Status | Simple note |
|---|---|---|
| Environment / Ollama | Pass | Local `gemma4:e2b-mlx` served through Ollama's OpenAI-compatible endpoint. |
| Harness package | Pass | Build, 30 tests, and tarball boundary passed. |
| Runtime package | Pass | Build, types, 68 tests, generated contract, and tarball passed. |
| Create-agent package | Pass | Build, 10 generator tests, and tarball passed. |
| Studio package / browser test | Pass | Build, 8 unit tests, Playwright, static host, and tarball passed. |
| Root workspace check | Pass | All five package gates passed in sequence. |
| Generated developer syntax | Pass | All three workspace-local fixtures checked and built with the two-import deferred factory. |
| Simple real-model final | Pass | Returned `ACK [single-real-ollama]` with real model metadata. |
| Real-model tool loop | Pass | Ollama selected `lookup-code`; Harness sealed and ran it; final contained `resolved-BLUE-42`. |
| Multi-turn Session | Pass | One Studio Session returned `studio-one` and `studio-two` in order. |
| Parallel Session isolation | Pass | Six concurrent Sessions retained their own sentinel and event Session ID. |
| REST / SSE / records | Pass | Monotonic SSE, two turns, AG-UI history, event paging, and terminal JSONL record verified. |
| Studio manifest | Pass | Rendered Harness package/version plus the bound model, middleware, adapters, and tools. |
| Studio real-model chat | Pass | Rendered chat completed against local Ollama. |
| Studio tool agent | Pass | Tools card listed `lookup-code`; rendered result contained `resolved-GREEN-77`. |
| Studio Harness events | Pass | Ordered observe, model, tool-adapter, final, and run-ended rows rendered. |
| Studio interaction controls | Pass | Approval prompt rendered; Approve resumed the same Session to `PUBLISHED: studio-approval`. |

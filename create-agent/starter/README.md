# My agent

The creator configures a provider before starting development. For later sessions, run `npm run dev`. If setup was skipped with `--skip-config` or interrupted, run `npm run configure` first, then `npm run dev`.
Edit agents under `agents/` and compose your Hono app in `src/index.ts`.

`npm run dev` starts your app on port 3000, waits until its agent endpoint is ready, then starts Studio and opens it in your browser. Use `npm run dev -- --no-open` to start Studio without opening a browser. Run `npm run studio` in another terminal to attach Studio separately. `npm run build` creates `dist/`; deploy it alongside `package.json`, installed production dependencies, and environment variables, then run `npm start`.

Development orchestration is provided by the installed `nylorun` CLI. Use `npm run dev -- --no-studio` for the application alone. Copy `.env.example` to `.env` and fill in `MODEL_PROVIDER`, `MODEL`, and `MODEL_PROVIDER_API_KEY`, or run `npm run configure`. Custom OpenAI-compatible providers also use `MODEL_PROVIDER_BASE_URL`. Hosting providers can supply these variables directly; no credential files are required for API keys. The single `tsconfig.json` builds your sources; `npm run check` checks types without emitting files.

## Runtime DX (openSession + serveAgents)

Talk to an agent with three calls — keep the session bag named **`info`** (not `user`):

```ts
import { openSession } from "@nylorun/runtime";
import { assistant } from "../agents/assistant/agent.js";

const session = openSession(assistant, { info: { id: "local-dev" } });
const accepted = await session.input("Hello");
for await (const event of session.stream()) {
  // turn.started · text.delta · turn.settled · …
}
```

Serve your code with `serveAgents`:

| Call | Returns | Use when |
|---|---|---|
| `serveAgents({ agents, runtime })` | Hono app | Node + Studio (`nylorun dev` mounts under `/agents`) |
| `serveAgents({ agents })` | `{ fetch }` | Workers, Bun, Deno, or a framework route (`export const POST = nylorun.fetch`) |

Do not put `model` on `Agent({})`. Local Runtime selects the model via env / `onModelCall`; Cloud owns the remote model loop.

## Cloud / sandbox

Optional. Point the same starter at Cloud Agents API:

```dotenv
NYLORUN_URL=https://sandbox.nylorun.dev
NYLORUN_SECRET_KEY=nyl_sk_…
# optional: NYLORUN_MODE=cloud
# force local despite URL/key: NYLORUN_MODE=local
```

`src/index.ts` exports the Hono app. `nylorun dev` and `nylorun start` supply the Node server and load `.env` without overriding process variables. OAuth state, when used, lives in ignored `.nylorun/auth.json`. Sessions use memory storage by default and disappear on process restart. For a single Node host, explicitly configure `localSessions({ root: ".data/sessions" })` from `@nylorun/runtime/node`. Shared storage alone does not provide distributed scheduling. See https://docs.nylorun.com/docs/run-agents/deploy for hosting guidance.

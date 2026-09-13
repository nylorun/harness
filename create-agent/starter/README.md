# My agent

The creator configures a provider before starting development. For later sessions, run `npm run dev`. If setup was skipped with `--skip-config` or interrupted, run `npm run configure` first, then `npm run dev`.
Edit agents under `agents/` and compose your Hono app in `src/index.ts`.

`npm run dev` starts your app on port 3000, waits until its agent endpoint is ready, then starts Studio and opens it in your browser. Use `npm run dev -- --no-open` to start Studio without opening a browser. Run `npm run studio` in another terminal to attach Studio separately. `npm run build` creates `dist/`; deploy it alongside `package.json`, installed production dependencies, and environment variables, then run `npm start`.

Development orchestration is provided by the installed `nylorun` CLI. Use `npm run dev -- --no-studio` for the application alone. Copy `.env.example` to `.env` and fill in `MODEL_PROVIDER`, `MODEL`, and `MODEL_PROVIDER_API_KEY`, or run `npm run configure`. Custom OpenAI-compatible providers also use `MODEL_PROVIDER_BASE_URL`. Hosting providers can supply these variables directly; no credential files are required for API keys. The single `tsconfig.json` builds your sources; `npm run check` checks types without emitting files.

`src/index.ts` exports the Hono app. `nylorun dev` and `nylorun start` supply the Node server and load `.env` without overriding process variables. OAuth state, when used, lives in ignored `.nylorun/auth.json`. Serverless session behavior and Workers compatibility require separate validation.

# My agent

The creator configures a provider before starting development. For later sessions, run `npm run dev`. If setup was skipped with `--skip-config` or interrupted, run `npm run configure` first, then `npm run dev`.
Edit agents under `agents/` and compose your Hono app in `src/index.ts`.

`npm run dev` starts your app on port 3000, waits until its agent endpoint is ready, then starts Studio and opens it in your browser. Use `npm run dev -- --no-open` to start Studio without opening a browser. Run `npm run studio` in another terminal to attach Studio separately. `npm run build` creates `dist/`; deploy it alongside `package.json`, installed production dependencies, and private project configuration, then run `npm start`.

Development orchestration is provided by the installed `nylorun` CLI. Use `npm run dev -- --no-studio` for the application alone. Local provider/model selection is stored in `.env/model.json`. The single `tsconfig.json` builds your sources; `npm run check` checks types without emitting files.

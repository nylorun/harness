# My agent

The creator configures a provider before starting development. For later sessions, run `npm run dev`. If setup was skipped with `--skip-config` or interrupted, run `npm run configure` first, then `npm run dev`.
Edit agents under `agent/` and compose Runtime in `nylorun.config.ts`.

`npm run dev -- --no-studio` starts without Studio. `npm run build` creates `dist/`; deploy it alongside `package.json`, installed production dependencies, and private project configuration, then run `npm start`.

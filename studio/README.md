# `@nylorun/studio`

Studio is an optional React developer workspace for Nylo agents. It is packaged as static assets and never enters a published agent bundle.

Install it in a project's `devDependencies`, then run:

```sh
npm run dev
```

Generated projects use `nylo dev --studio`. It builds and watches the local agent, starts its Agent Server on `--port`, then `PORT`, then `4111`, and starts Studio on the first free loopback URL from `http://nylo.run.localhost:4161` through `:4260`. Studio's URL is stable across rebuilds; the Agent Server restarts on the same selected port after a successful rebuild.

Studio serves `/nylo-studio.config.json` dynamically from memory with the local Agent Server URL. It never writes this configuration into the project or `dist/`. Use `--no-open` to prevent opening a browser.

`nylo studio` remains available when you want only the static host:

```sh
nylo studio --agent-server-url https://agent.example.internal
```

To connect the static Studio to a developer-owned Agent Server instead:

```sh
nylo studio --agent-server-url https://agent.example.internal
```

`--runtime-url` is retained as a deprecated alias. Studio hosts no Agent Server proxy, token bootstrap, browser API, Run-record reader, or session credentials. The browser directly reads Agent Server metadata and sessions, uses AG-UI SSE for chat, and reads the canonical event stream for inspection.

## Dashboards

`/` is the Agent Dashboard. Its Agent tab renders the build manifest and local relative record path when one is available; its Sessions tab lists persisted sessions. Selecting a session, or the top-bar New Session button, opens `/session/:sessionId`. A draft ID becomes persistent only when its first chat message reaches the Agent Server.

The Session Dashboard has Chat and Events tabs. Chat uses assistant-ui's AG-UI runtime with `HttpAgent` against `/v1/ag-ui`; Events uses canonical Nylo events and opens a detail Sheet. The fixed top bar shows the breadcrumb, New Session action, and the directly-polled Agent Server state. No Studio request carries cookies or credentials.

## Private static deployment

Build the package and host `dist/web/` with any private static web server. Place this non-secret configuration file alongside `index.html`:

```json
{ "agentServerUrl": "https://agent.example.internal" }
```

Do not put API keys, cookies, or other credentials in `nylo-studio.config.json`. An HTTPS Studio cannot use an HTTP Agent Server URL because browsers block mixed content.

The Agent Server must explicitly allow the Studio origin through `Fetchable` CORS configuration. CORS is not authentication; private deployments must provide their own network and access controls when they need them.

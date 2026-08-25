# ollama-approval

Generated with @nylorun/create-agent.

```sh
npm run check
npm run dev
npm run build
npm run serve
npm run studio
```

## Model gateway

Copy `.env.example` to `.env` only when your model gateway needs configuration. A local
OpenAI-compatible server is detected automatically; any compatible gateway can be configured with
`NYLO_MODEL_GATEWAY_URL` and, when needed, `NYLO_MODEL_GATEWAY_API_KEY`.

Start sessions through the REST API after `npm run serve`. Credentials are read from your
environment first, then `.env`; values are never printed or uploaded.

```sh
# Start a session, then follow its event stream.
curl -X POST http://127.0.0.1:4111/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"agent_id":"ollama-approval","message":"Hello"}'
curl -N http://127.0.0.1:4111/v1/sessions/<session-id>/stream
```

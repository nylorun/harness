import assert from "node:assert/strict";
const base = process.argv[2]?.replace(/\/$/, "");
if (!base || !/^https?:\/\//.test(base))
  throw new Error(
    "Usage: node scripts/smoke-deployed.mjs https://test-app.example/agents",
  );
const headers = process.env.SMOKE_BEARER_TOKEN
  ? { authorization: `Bearer ${process.env.SMOKE_BEARER_TOKEN}` }
  : {};
const request = (url, options = {}) =>
  fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
    signal: AbortSignal.timeout(120_000),
  });
const discovery = await request(`${base}/v1/agents`);
assert.equal(discovery.status, 200);
const { agents } = await discovery.json();
assert.ok(agents.length);
const agent = agents[0].id;
const session = `deployment-smoke-${crypto.randomUUID()}`;
const response = await request(`${base}/${agent}/v1/ag-ui`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    threadId: session,
    runId: session,
    messages: [
      {
        role: "user",
        content: "Reply with a short greeting without using tools.",
      },
    ],
  }),
});
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type"), /text\/event-stream/);
const reader = response.body.getReader();
const decoder = new TextDecoder();
let events = "",
  frames = 0;
for (;;) {
  const item = await reader.read();
  if (item.done) break;
  events += decoder.decode(item.value, { stream: true });
  frames++;
}
assert.match(events, /RUN_STARTED/);
assert.match(events, /RUN_FINISHED/);
assert.doesNotMatch(events, /"type":"RUN_ERROR"/);
console.log(
  JSON.stringify(
    {
      endpoint: base,
      agent,
      session,
      frames,
      verifiedAt: new Date().toISOString(),
      checks: [
        "discovery",
        "model invocation",
        "SSE response",
        "terminal settlement",
      ],
      limits:
        "This does not verify cross-instance storage, reconnection, or distributed ownership.",
    },
    null,
    2,
  ),
);

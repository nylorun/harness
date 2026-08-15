// A minimal OpenAI-compatible /chat/completions SSE endpoint.
//
// It exists so CI can exercise the whole run path — resolve a credential, reach a provider, stream
// deltas, end a session — without a real API key and without leaving the runner. Point a run at it
// with NYLO_PROVIDER_BASE_URL.
//
// Prints `PORT=<n>` on startup and serves every request identically.
import { createServer } from "node:http";

const FRAMES = [
  { choices: [{ delta: { content: "Hello" } }] },
  { choices: [{ delta: { content: ", world." } }] },
  { choices: [{ finish_reason: "stop", delta: {} }] },
  { usage: { prompt_tokens: 11, completion_tokens: 4 } }
];

const server = createServer((request, response) => {
  if (!request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of FRAMES) response.write(`data: ${JSON.stringify({ model: "stub", ...frame })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
});

server.listen(Number(process.env.PORT ?? 0), () => {
  console.log(`PORT=${server.address().port}`);
});

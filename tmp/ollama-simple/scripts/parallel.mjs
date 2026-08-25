import { agent } from "../dist/agent.mjs";

const hosted = agent.withHost({
  env: {
    ...process.env,
    NYLO_MODEL_GATEWAY_URL: "http://127.0.0.1:11434/v1",
    NYLO_MODEL_GATEWAY_PROTOCOL: "openai-chat-completions",
    NYLO_MODEL_GATEWAY_ACCESS_MODE: "private-or-local-endpoint",
  },
});

const tokens = Array.from({ length: 6 }, (_, index) => `parallel-${index}-${crypto.randomUUID().slice(0, 8)}`);
const results = await Promise.all(tokens.map(async (token, index) => {
  const run = hosted.session.start(`Current token: [${token}]`, { sessionId: `parallel-${index}` });
  const events = [];
  for await (const event of run.events) events.push(event);
  const result = await run.result;
  return { token, output: result.output, events };
}));

for (const result of results) {
  const foreign = tokens.filter((token) => token !== result.token && result.output.includes(token));
  if (!result.output.includes(result.token) || foreign.length > 0) throw new Error(`Session isolation failed: ${JSON.stringify(result)}`);
  if (result.events.some((event) => event.session !== result.events[0]?.session)) throw new Error("Cross-session event identity detected");
  console.log("[parallel] isolated", result.token, "=>", result.output.trim());
}

await hosted.close();
console.log(`[parallel] PASS ${results.length} real Ollama sessions`);

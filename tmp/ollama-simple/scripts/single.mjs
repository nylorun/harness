import { agent } from "../dist/agent.mjs";

const hosted = agent.withHost({ env: { ...process.env, NYLO_MODEL_GATEWAY_URL: "http://127.0.0.1:11434/v1", NYLO_MODEL_GATEWAY_PROTOCOL: "openai-chat-completions", NYLO_MODEL_GATEWAY_ACCESS_MODE: "private-or-local-endpoint" } });
const run = hosted.session.start("Current token: [single-real-ollama]", { sessionId: "single-real-ollama" });
for await (const event of run.events) console.log("[event]", event.seq, event.type, JSON.stringify(event.payload));
const result = await run.result;
if (!result.output.includes("single-real-ollama")) throw new Error(`Unexpected model output: ${result.output}`);
console.log("[result]", result.output.trim());
await hosted.close();

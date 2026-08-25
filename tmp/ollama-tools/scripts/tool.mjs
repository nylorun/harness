import { agent } from "../dist/agent.mjs";

const hosted = agent.withHost({ env: { ...process.env, NYLO_MODEL_GATEWAY_URL: "http://127.0.0.1:11434/v1", NYLO_MODEL_GATEWAY_PROTOCOL: "openai-chat-completions", NYLO_MODEL_GATEWAY_ACCESS_MODE: "private-or-local-endpoint" } });
const run = hosted.session.start("Resolve code BLUE-42.", { sessionId: "tool-real-ollama" });
const events = [];
for await (const event of run.events) { events.push(event); console.log("[event]", event.seq, event.type, JSON.stringify(event.payload)); }
const result = await run.result;
if (!events.some((event) => event.type === "harness.observe" && event.payload.observation === "adapter.completed")) throw new Error("The Harness adapter never completed a tool call");
if (!result.output.includes("resolved-BLUE-42")) throw new Error(`Unexpected model output: ${result.output}`);
console.log("[result]", result.output.trim());
await hosted.close();

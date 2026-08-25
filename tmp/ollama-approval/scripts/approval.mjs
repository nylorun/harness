import { agent } from "../dist/agent.mjs";

const hosted = agent.withHost({ env: { ...process.env, NYLO_MODEL_GATEWAY_URL: "http://127.0.0.1:11434/v1", NYLO_MODEL_GATEWAY_PROTOCOL: "openai-chat-completions", NYLO_MODEL_GATEWAY_ACCESS_MODE: "private-or-local-endpoint" } });
const first = hosted.session.start("approval-green", { sessionId: "approval-real-ollama" });
for await (const event of first.events) console.log("[event]", event.seq, event.type, JSON.stringify(event.payload));
const waiting = await first.result;
const interaction = waiting.state.pendingInteraction;
if (waiting.state.status !== "waiting" || interaction?.kind !== "approval") throw new Error("Harness did not pause for approval");
const accepted = await hosted.session.interact("approval-real-ollama", { kind: "approve", interactionId: interaction.id, approved: true });
if (!accepted) throw new Error("Runtime rejected the approval");
await hosted.session.settled("approval-real-ollama");
const events = await hosted.session.events("approval-real-ollama") ?? [];
const final = [...events].reverse().find((event) => event.type === "final");
if (!String(final?.payload.output).includes("approval-green")) throw new Error("Approval did not resume to a final result");
console.log("[approval] PASS", final.payload.output);
await hosted.close();

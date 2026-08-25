import {
  AgentBuildError,
  Harness,
  defineAdapter,
  defineCapability,
  defineModel,
  defineTool,
} from "@nylorun/harness";
import { z } from "zod";

const sessionCount = 64;
const executions = new Map();

const localAdapter = defineAdapter({
  id: "interleaved-local",
  validateRoute() {},
  async execute(call) {
    const { sessionId, payload } = call.args;
    await new Promise((resolve) => setTimeout(resolve, Number(sessionId.slice(-2)) % 7));
    executions.set(sessionId, [...(executions.get(sessionId) ?? []), payload]);
    console.log("[adapter]", sessionId, payload);
    return { kind: "completed", output: { sessionId, payload } };
  },
});

const rememberTool = defineTool({
  name: "remember_for_step",
  description: "Return one Session-owned payload to its next Step",
  input: z.object({ sessionId: z.string(), payload: z.string() }),
  executeWith: "local",
  route: { operation: "remember" },
});

const model = defineModel({
  id: "parallel-model",
  async invoke(request) {
    await new Promise((resolve) => setTimeout(resolve, Number(request.sessionId.slice(-2)) % 5));
    if (request.toolResults.length === 0) {
      const arrival = request.arrivals.find((event) => event.kind === "user-message");
      return {
        toolCalls: [{
          id: `call-${request.sessionId}`,
          name: "remember_for_step",
          args: { sessionId: request.sessionId, payload: arrival?.text ?? "missing" },
        }],
      };
    }
    return `${request.toolResults[0].output.sessionId}|${request.toolResults[0].output.payload}`;
  },
});

const built = await new Harness({ model, adapters: { local: localAdapter } })
  .add(defineCapability({ id: "parallel-isolation", setup: () => ({ tools: [rememberTool] }) }))
  .build();
if (!built.ok) throw new AgentBuildError(built.diagnostics);

const sessions = Array.from({ length: sessionCount }, (_, index) => {
  const suffix = String(index).padStart(2, "0");
  const payload = `payload::${suffix}::END`;
  const session = built.agent.run({ id: `parallel-${suffix}` });
  const handle = session.input(payload);
  return {
    session,
    payload,
    completion: handle.completed,
  };
});

// Submission is eager: all Sessions run even though no async iterator is pulled.
const completions = await Promise.all(sessions.map(({ completion }) => completion));

for (let index = 0; index < sessions.length; index += 1) {
  const { session, payload } = sessions[index];
  const final = completions[index].events.find((event) => event.type === "final");
  const expected = `${session.id}|${payload}`;
  if (!final || final.type !== "final" || final.output !== expected) {
    throw new Error(`Cross-session output detected for ${session.id}: ${JSON.stringify(final)}`);
  }
  if (JSON.stringify(session.state.transcript).includes(sessions[(index + 1) % sessions.length].payload)) {
    throw new Error(`Cross-session transcript detected for ${session.id}`);
  }
  if (session.state.pendingInteraction || session.state.status !== "idle") {
    throw new Error(`Session did not return to isolated idle state: ${session.id}`);
  }
  if (executions.get(session.id)?.join() !== payload) {
    throw new Error(`Adapter execution leaked for ${session.id}`);
  }
}

console.log(`[result] ${sessionCount} parallel Sessions completed with isolated output, transcript, and adapter state`);
await Promise.all(sessions.map(({ session }) => session.stop()));


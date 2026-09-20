import { Agent, type ModelAdapter } from "@nylorun/harness";
import {
  Runtime,
  openSession,
  serveAgents,
  type RuntimeAgent,
  type ServeAgentsFetch,
} from "@nylorun/runtime";
import { piModel } from "@nylorun/runtime/node";

const model: ModelAdapter = piModel();
void model;

const agent: RuntimeAgent = Agent({ id: "test", name: "Test" }).build();
void agent;

// Hono compat (Studio / nylorun dev mount).
void serveAgents({ agents: [agent], runtime: new Runtime() });

// DX `{ fetch }` shape (no runtime arg).
const shaped: ServeAgentsFetch = serveAgents({ agents: [agent] });
void shaped.fetch;

// Session SDK — `info` not `user`; no model on Agent.
void openSession(agent, { info: { id: "typecheck" } });

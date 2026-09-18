import { Agent, type ModelAdapter } from "@nylorun/harness";
import { Runtime, serveAgents, type RuntimeAgent } from "@nylorun/runtime";
import { piModel } from "@nylorun/runtime/node";
const model: ModelAdapter = piModel();
void model;
const agent: RuntimeAgent = Agent({ id: "test", name: "Test" }).build();
void serveAgents({ agents: [agent], runtime: new Runtime() });

import { Agent, type ModelAdapter } from "@nylorun/harness";
import { Runtime, piModel, serveAgents, type RuntimeAgent } from "@nylorun/runtime";
const model: ModelAdapter = piModel();
void model;
const agent: RuntimeAgent = Agent({ id: "test", name: "Test" }).build();
void serveAgents({ agents: [agent], runtime: new Runtime() });

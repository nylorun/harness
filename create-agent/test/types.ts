import { Agent, type ModelAdapter } from "@nylorun/harness";
import { defineRuntime, piModel, type RuntimeAgent } from "@nylorun/runtime";
const model: ModelAdapter = piModel();
const agent: RuntimeAgent = Agent({ id: "test", name: "Test" })
  .with(model)
  .build();
defineRuntime({ agents: [agent] });

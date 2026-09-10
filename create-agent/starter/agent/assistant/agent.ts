import { Agent } from "@nylorun/harness";
import { piModel } from "@nylorun/runtime";

export const assistant = Agent({
  id: "assistant",
  name: "Assistant",
  instructions: ["You are helpful."],
})
  .with(piModel())
  .build();

import { Agent } from "@nylorun/harness";

export const assistant = Agent({
  id: "assistant",
  name: "Assistant",
  instructions: ["You are helpful."],
}).build();

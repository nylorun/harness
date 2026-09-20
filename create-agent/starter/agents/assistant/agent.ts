import { Agent } from "@nylorun/harness";

/** Definition only — no `model` here; Runtime / Cloud owns model calls. */
export const assistant = Agent({
  id: "assistant",
  name: "Assistant",
  instructions: ["You are helpful."],
}).build();

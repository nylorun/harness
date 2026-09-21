import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "../src/define.js";
it("keeps live code and schemas in a non-serialized binding", () => {
  const run = async ({ value }: { value: number }) => value;
  const outputSchema = z.object({ value: z.number() });
  const agent = Agent({
    id: "binding",
    name: "Binding",
    outputSchema,
    tools: [
      tool({ name: "value", input: z.object({ value: z.number() }), run }),
    ],
  }).build();
  const binding = agent.getBinding();
  expect(Object.keys(agent)).not.toContain("getBinding");
  expect(JSON.parse(JSON.stringify(agent))).toEqual(agent.manifest);
  expect(binding.outputSchema).toBe(outputSchema);
  expect(binding.manifest).toBe(agent.manifest);
  expect(typeof binding.implementations.agent.tools?.value.execute).toBe(
    "function"
  );
  expect(binding.declarations.map((d) => d.id)).toEqual(["agent"]);
  expect(Object.isFrozen(binding)).toBe(true);
});

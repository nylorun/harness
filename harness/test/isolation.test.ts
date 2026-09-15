import { expect, it } from "vitest";
import { Agent } from "../src/index.js";

it("isolates state, scope, and execution identities in concurrent calls", async () => {
  const scopes: unknown[] = [];
  const agent = Agent<{ name: string }>({ id: "a", name: "A" })
    .use("scope", async (request, next) => {
      scopes.push(request.scope);
      request.context.set("name", [{ value: request.scope!.name }]);
      return next();
    })
    .build();
  const results = await Promise.all(
    ["a", "b", "c"].map((name) =>
      agent.run({
        input: name,
        scope: { name },
        onModelCall: async (_, { request }) => {
          await Promise.resolve();
          return String(request.context.items[0]!.value);
        },
      }),
    ),
  );
  expect(results.map((result) => result.status === "completed" && result.output)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(new Set(results.map((result) => result.state.executionId)).size).toBe(3);
  expect(scopes).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
});

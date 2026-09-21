import { expect, it } from "vitest";
import { createClient } from "../src/client.js";
it("shares authenticated, abortable discovery for Studio and application clients", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const controller = new AbortController();
  const client = createClient({
    url: "http://localhost:8787",
    key: "test-key",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(
        String(url).includes("/agents") ? { agents: [] } : { sessions: [] }
      );
    },
  });
  expect(await client.listAgents({ signal: controller.signal })).toEqual({
    agents: [],
  });
  expect(
    await client.listSessions({ agentId: "a/b", signal: controller.signal })
  ).toEqual({ sessions: [] });
  expect(calls.map((c) => c.url)).toEqual([
    "http://localhost:8787/v1/agents",
    "http://localhost:8787/v1/sessions?agentId=a%2Fb",
  ]);
  for (const call of calls) {
    expect(new Headers(call.init?.headers).get("authorization")).toBe(
      "Bearer test-key"
    );
    expect(call.init?.signal).toBe(controller.signal);
  }
});

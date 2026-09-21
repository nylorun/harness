import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { Runtime, serveAgents } from "./legacy-api.js";

it.each(["policy", "model"])(
  "reports %s failures without a successful final message",
  async (kind) => {
    const agent = Agent({ id: "failure", name: "Failure" })
      .use("policy", async (request, next) =>
        kind === "policy"
          ? request.tripwire({
              code: "input.blocked",
              message: "Blocked by policy",
            })
          : next(),
      )
      .build();
    const runtime = new Runtime({
      onModelCall: async () => {
        throw new Error("Provider failed");
      },
    });
    const app = serveAgents({ agents: [agent], runtime });
    for (let i = 0; i < 2; i++) {
      const response = await app.request("/failure/v1/ag-ui", {
        method: "POST",
        body: JSON.stringify({
          threadId: "session",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      const text = await response.text();
      expect(text).toContain("RUN_ERROR");
      expect(text).not.toContain("TEXT_MESSAGE_CONTENT");
      expect((await runtime.host.read("failure", "session"))?.status).toBe(
        "failed",
      );
    }
    await runtime.close();
  },
);

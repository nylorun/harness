import { expect, it } from "vitest";
import { LocalMcp } from "../agent/mcp/client.js";
it("runs and closes the bundled MCP subprocess", async () => {
  const mcp = new LocalMcp();
  try {
    expect(await mcp.add(12, 30)).toMatchObject({ sum: 42 });
  } finally {
    await mcp.close();
  }
});

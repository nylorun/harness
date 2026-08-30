import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

/** A real local stdio MCP connection, deliberately constrained to the bundled demo server. */
export class LocalMcp {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;

  async add(left: number, right: number): Promise<unknown> {
    const client = await this.connect();
    const result = await client.callTool({ name: "mcp_add", arguments: { left, right } });
    return result.structuredContent ?? result.content;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(new URL("../scripts/mcp-server.mjs", import.meta.url).pathname)],
    });
    const client = new Client(
      { name: "nylorun-harness-examples", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    await client.listTools();
    this.client = client;
    this.transport = transport;
    return client;
  }
}

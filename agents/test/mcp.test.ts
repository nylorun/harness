import { Agent } from "@nylorun/core/define";
import { AgentManifestSchema } from "@nylorun/core/contracts";
import { expect, it } from "vitest";
import { mcp, McpError } from "../src/mcp/index.js";

const github = {
  name: "github",
  type: "streamable-http" as const,
  url: "https://mcp.example.com/github",
};

it("builds a capability for Agent.use from an mcpServers map", () => {
  const declaration = mcp({
    github: {
      ...github,
      headers: { "X-Tenant": "public" },
    },
  });
  expect(declaration).toMatchObject({
    id: "mcp",
    mcpServers: {
      github: {
        name: "github",
        type: "streamable-http",
        url: "https://mcp.example.com/github",
        headers: { "X-Tenant": "public" },
      },
    },
  });

  const agent = Agent({
    id: "assistant",
    name: "Order assistant",
    instructions: "Use lookup_order for orders.",
  })
    .use(mcp({ github }))
    .build();

  expect(
    agent.manifest.capabilities.find((item) => item.id === "mcp")
  ).toMatchObject({
    id: "mcp",
    type: "agent",
    mcpServers: { github },
  });
});

it("accepts stdio and sse transports and an explicit capability id", () => {
  const declaration = mcp(
    {
      local: {
        name: "local",
        type: "stdio",
        command: "npx",
        args: ["-y", "demo-mcp"],
        env: { MODE: "test" },
        cwd: ".",
      },
      legacy: {
        name: "legacy",
        type: "sse",
        url: "https://mcp.example.com/sse",
      },
    },
    { id: "integrations" }
  );
  expect(declaration.id).toBe("integrations");
  expect(Object.keys(declaration.mcpServers).sort()).toEqual(["legacy", "local"]);

  const agent = Agent({ id: "assistant", instructions: "Help." })
    .use(
      mcp(
        {
          github,
          local: {
            name: "local",
            type: "stdio",
            command: "./bin/tools",
          },
        },
        { id: "integrations" }
      )
    )
    .build();
  expect(
    agent.manifest.capabilities.find((item) => item.id === "integrations")
  ).toMatchObject({
    id: "integrations",
    mcpServers: {
      github,
      local: { name: "local", type: "stdio", command: "./bin/tools" },
    },
  });
});

it("composes with the existing .use({ id, mcpServers }) pattern", () => {
  const agent = Agent({ id: "assistant", instructions: "Help." })
    .use({
      id: "inline",
      mcpServers: {
        docs: {
          name: "docs",
          type: "streamable-http",
          url: "https://mcp.example.com/docs",
        },
      },
    })
    .use(mcp({ github }, { id: "github-mcp" }))
    .build();

  expect(
    agent.manifest.capabilities
      .filter((item) => item.mcpServers)
      .map((item) => item.id)
      .sort()
  ).toEqual(["github-mcp", "inline"]);
  expect(
    agent.manifest.capabilities.find((item) => item.id === "github-mcp")
      ?.mcpServers
  ).toEqual({ github });
});

it("rejects an empty map, a name mismatch, and an invalid server", () => {
  expect(() => mcp({})).toThrow(McpError);
  try {
    mcp({});
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe("mcp.empty");
  }

  expect(() =>
    mcp({
      other: github,
    })
  ).toThrow(/must equal the server name/);
  try {
    mcp({ other: github });
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe("mcp.name-mismatch");
  }

  expect(() =>
    mcp({
      broken: { name: "broken", type: "streamable-http" } as never,
    })
  ).toThrow(McpError);
});

it("produces a manifest schema that rejects duplicate MCP server names", () => {
  const agent = Agent({ id: "assistant", instructions: "Help." })
    .use(mcp({ github }, { id: "one" }))
    .use(mcp({ github }, { id: "two" }))
    .build();
  const parsed = AgentManifestSchema.safeParse(agent.manifest);
  expect(parsed.success).toBe(false);
});

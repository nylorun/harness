import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "nylorun-assets-"));
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(output)),
    );
  });
}
try {
  await symlink(
    join(repo, "examples/node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  await cp(join(repo, "examples/agent"), join(root, "agent"), {
    recursive: true,
  });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@nylorun/harness": "*",
        "@nylorun/runtime": "*",
        "@modelcontextprotocol/sdk": "*",
        zod: "*",
        "zod-from-json-schema": "*",
      },
    }),
  );
  await writeFile(
    join(root, "nylorun.config.ts"),
    `
import { defineRuntime } from "@nylorun/runtime";
import { createRegistry } from "./agent/registry.js";
const adapter = async (call) => {
  const result = call.prompt.find((part) => part.kind === "tool-result");
  if (result) return { output: [{ type: "text", text: JSON.stringify(result.content) }] };
  const tool = call.tools.find((tool) => ["mcp_add", "load_skill", "calculate"].includes(tool.name));
  const args = tool.name === "mcp_add" ? { left: 12, right: 30 } : tool.name === "load_skill" ? { name: "structured-summary" } : { expression: "2+2" };
  return { output: [{ type: "tool-call", id: "test", name: tool.name, args }], finishReason: "tool-calls" };
};
export default defineRuntime({ agents: await createRegistry(process.cwd(), { adapter, provider: "test", model: "test" }) });
`,
  );
  await run([join(repo, "runtime/dist/cli.js"), "build"]);
  await rm(join(root, "agent"), { recursive: true });
  const result = await run([
    "--input-type=module",
    "-e",
    `
import config from './dist/nylorun.config.js';
const results = {};
try {
  for (const id of ['skills', 'tool-use', 'mcp']) {
    const agent = config.agents.find((agent) => agent.id === id);
    const session = agent.run();
    try {
      const result = await session.input('use the tool').completed;
      results[id] = result.events.find((event) => event.type === 'final')?.output;
    } finally { await session.stop(); }
  }
  console.log(JSON.stringify(results));
} finally { await Promise.all(config.agents.map((agent) => agent.close?.())); }
`,
  ]);
  const outputs = JSON.parse(result);
  assert.match(outputs.skills, /structured-summary/);
  assert.match(outputs["tool-use"], /4/);
  assert.match(outputs.mcp, /42/);
  console.log(
    "Built example assets passed: skill catalog, tool catalog, and real MCP subprocess with source removed.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

import { createServer, type Server } from "node:http";
import { test, expect } from "@playwright/test";
import { startStudio } from "../../dist/host.js";

async function listen(server: Server): Promise<number> { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); const address = server.address(); if (address === null || typeof address === "string") throw new Error("Agent server did not report a port."); return address.port; }
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }

test("Studio discovers and displays multiple agent manifests", async ({ page }) => {
  let studioOrigin = "";
  const server = createServer((request, response) => {
    if (request.headers.origin !== studioOrigin) { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": studioOrigin });
    if (request.url === "/v1/agents") response.end(JSON.stringify({ protocolVersion: 1, agents: [{ id: "tools", manifestUrl: "/agents/tools/manifest.json" }, { id: "mcp", manifestUrl: "/agents/mcp/manifest.json" }] }));
    else if (request.url?.endsWith("manifest.json")) { const id = request.url.includes("mcp") ? "mcp" : "tools"; response.end(JSON.stringify({ protocolVersion: 1, id, name: id === "mcp" ? "Local MCP" : "In-process tools", description: "Fixture agent", capabilities: id === "mcp" ? ["MCP stdio"] : ["calculator"], model: { provider: "test", id: "fixture" }, harness: { name: "@nylorun/harness", version: "0.7.0-beta.1", manifest: { middleware: [{ id: "model" }] }, }, endpoints: { agUi: `/agents/${id}/v1/ag-ui`, sessions: `/agents/${id}/v1/sessions` } })); }
    else if (request.url?.includes("/sessions")) response.end('{"sessions":[]}');
    else response.end('{}');
  });
  const port = await listen(server); const studio = await startStudio({ agentServerUrl: `http://127.0.0.1:${port}`, port: 0, open: false }); studioOrigin = studio.address;
  try { await page.goto(studio.address); await expect(page.getByText("In-process tools")).toBeVisible(); await expect(page.getByText("Local MCP")).toBeVisible(); await page.getByText("Local MCP").click(); await expect(page.getByText("MCP stdio")).toBeVisible(); } finally { await studio.close(); await close(server); }
});

import { createServer, type Server } from "node:http";
import { test, expect } from "@playwright/test";
import { startStudio } from "../../dist/host.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Agent Server did not report a TCP port.");
  return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

test("a Studio page can fetch its configured cross-origin Agent Server", async ({ page }) => {
  let studioOrigin = "";
  const agentServer = createServer((request, response) => {
    if (request.headers.origin !== studioOrigin) { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { "access-control-allow-origin": studioOrigin, "content-type": "application/json" });
    if (request.url === "/v1/agent") {
      response.end(JSON.stringify({ protocolVersion: 1, agentServerVersion: "test", capabilities: ["ag-ui"], agUiUrl: "/v1/ag-ui", harness: { model: { id: "local/gemma4:e2b-mlx" }, middleware: [{ id: "nylorun-durable" }, { id: "nylorun-folder" }], adapters: [{ id: "runtime-local" }] }, manifest: { sdkVersion: "test", agent: { name: "browser-fixture", model: "local/gemma4:e2b-mlx" }, harness: { name: "@nylorun/harness", version: "0.5.0-beta.1", capabilities: ["sessions", "isolation"] }, requirements: {}, tools: [], skills: [], mcp: [], bundleDigest: "bundle", digest: "manifest" } }));
    } else if (request.url === "/v1/sessions") response.end('{"sessions":[]}\n');
    else response.end('{"ok":true}\n');
  });
  const agentPort = await listen(agentServer);
  const agentServerUrl = `http://127.0.0.1:${agentPort}`;
  const studio = await startStudio({ project: process.cwd(), agentServerUrl, port: 0, open: false });
  studioOrigin = studio.address;
  try {
    await page.goto(studio.address);
    await expect(page.getByText("Running", { exact: true })).toBeVisible();
    await expect(page.getByText("browser-fixture")).toBeVisible();
    await expect(page.getByText("@nylorun/harness")).toBeVisible();
    await expect(page.getByText("Bound Harness")).toBeVisible();
    await expect(page.getByText("nylorun-folder")).toBeVisible();
    await expect(page.getByText("runtime-local")).toBeVisible();
    await expect(page.evaluate(async (url) => {
      const response = await fetch(`${url}/probe`);
      return { status: response.status, body: await response.json() };
    }, agentServerUrl)).resolves.toEqual({ status: 200, body: { ok: true } });
  } finally {
    await studio.close();
    await close(agentServer);
  }
});

test("a Studio page tolerates an Agent Server that does not report a bound Harness", async ({ page }) => {
  let studioOrigin = "";
  const agentServer = createServer((request, response) => {
    if (request.headers.origin !== studioOrigin) { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { "access-control-allow-origin": studioOrigin, "content-type": "application/json" });
    if (request.url === "/v1/agent") {
      response.end(JSON.stringify({ protocolVersion: 1, agentServerVersion: "legacy-test", capabilities: ["ag-ui"], agUiUrl: "/v1/ag-ui", manifest: { sdkVersion: "test", agent: { name: "legacy-browser-fixture", model: "local/gemma4:e2b-mlx" }, harness: { name: "@nylorun/harness", version: "0.5.0-beta.1", capabilities: [] }, requirements: {}, tools: [], skills: [], mcp: [], bundleDigest: "bundle", digest: "manifest" } }));
    } else if (request.url === "/v1/sessions") response.end('{"sessions":[]}\n');
    else response.end('{"ok":true}\n');
  });
  const agentPort = await listen(agentServer);
  const studio = await startStudio({ project: process.cwd(), agentServerUrl: `http://127.0.0.1:${agentPort}`, port: 0, open: false });
  studioOrigin = studio.address;
  try {
    await page.goto(studio.address);
    await expect(page.getByText("legacy-browser-fixture")).toBeVisible();
    await expect(page.getByText("Bound Harness")).toBeVisible();
    await expect(page.getByText("Not reported by this Agent Server").first()).toBeVisible();
  } finally {
    await studio.close();
    await close(agentServer);
  }
});

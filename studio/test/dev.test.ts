import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDevArgs } from "../src/dev-args.js";
import { startDevelopment } from "../src/dev.js";
import { startStaticStudio } from "../src/host.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not report a TCP port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".nylo-studio-dev-"));
  await mkdir(join(root, "agent"), { recursive: true });
  await mkdir(join(root, "node_modules", "@nylorun"), { recursive: true });
  await symlink(new URL("../../create-agent/", import.meta.url).pathname, join(root, "node_modules", "@nylorun", "create-agent"), "dir");
  await symlink(new URL("../../harness/", import.meta.url).pathname, join(root, "node_modules", "@nylorun", "harness"), "dir");
  await symlink(new URL("../../node_modules/zod/", import.meta.url).pathname, join(root, "node_modules", "zod"), "dir");
  await writeFile(join(root, "package.json"), '{"name":"studio-fixture","type":"module"}\n');
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(root, "nylo.local.ts"), 'export { Run, nyloAgent } from "@nylorun/create-agent/local";\n');
  await writeFile(join(root, "vite.config.ts"), 'import { nyloAgent } from "./nylo.local.js";\nexport default { plugins: [nyloAgent()] };\n');
  await writeFile(join(root, "agent", "AGENT.md"), "You are helpful.\n");
  await writeFile(join(root, "agent", "agent.ts"), 'import { Agent } from "@nylorun/harness";\nimport { Run } from "../nylo.local.js";\nexport default Run((model,directive)=>Agent(model,directive),{name:"sample",model:"anthropic/example"});\n');
  return root;
}

describe("nylo dev options", () => {
  it("uses --port before PORT and the default", () => {
    expect(parseDevArgs(["--studio", "--port", "4200"], "usage", "/project", { PORT: "4300" })).toMatchObject({ project: "/project", studio: true, port: 4200 });
    expect(parseDevArgs([], "usage", "/project", { PORT: "4300" })).toMatchObject({ port: 4300, studio: false });
    expect(parseDevArgs([], "usage", "/project", {})).toMatchObject({ port: 4111, studio: false });
  });

  it("serves no-store in-memory configuration", async () => {
    const studio = await startStaticStudio({ agentServerUrl: "http://127.0.0.1:4111", port: 0, open: false });
    try {
      const response = await fetch(`${studio.address}/nylo-studio.config.json`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ agentServerUrl: "http://127.0.0.1:4111" });
    } finally {
      await studio.close();
    }
  });

  it("pairs a fixed-port Agent Server with an automatic Studio and rebuilds in place", async () => {
    const root = await project();
    const port = await availablePort();
    let dev: Awaited<ReturnType<typeof startDevelopment>> | undefined;
    try {
      dev = await startDevelopment({ project: root, port, studio: true, open: false });
      expect(dev.agentServerUrl).toBe(`http://127.0.0.1:${port}`);
      expect(new URL(dev.studioAddress!).hostname).toBe("nylo.run.localhost");
      expect(Number(new URL(dev.studioAddress!).port)).toBeGreaterThanOrEqual(4161);
      expect(Number(new URL(dev.studioAddress!).port)).toBeLessThanOrEqual(4260);
      const config = await fetch(`${dev.studioAddress}/nylo-studio.config.json`);
      await expect(config.json()).resolves.toEqual({ agentServerUrl: dev.agentServerUrl });
      const preflight = await fetch(`${dev.agentServerUrl}/v1/sessions`, {
        method: "OPTIONS",
        headers: { origin: dev.studioAddress!, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBe(dev.studioAddress);

      await writeFile(join(root, "agent", "agent.ts"), 'import { Agent } from "@nylorun/harness";\nimport { Run } from "../nylo.local.js";\nexport default Run((model,directive)=>Agent(model,directive),{name:"rebuilt",model:"anthropic/example"});\n');
      await expect.poll(async () => {
        const response = await fetch(`${dev!.agentServerUrl}/v1/sessions`, {
          method: "POST",
          headers: { origin: dev!.studioAddress!, "content-type": "application/json" },
          body: JSON.stringify({ agent_id: "rebuilt" })
        });
        return response.status;
      }, { timeout: 10_000 }).toBe(202);
    } finally {
      await dev?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import { writeLink } from "../src/project/link.js";
import { writeCredentials } from "../src/project/credentials.js";
import { newTenantId } from "@nylorun/agents";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function startHost() {
  const catalog = {
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
      },
    ],
  };
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    if (url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: "ok",
          protocol: {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
            features: [...PROTOCOL_FEATURES],
          },
          hostId: "host_01habcdefghijklmnopqrstuvw",
        }),
      );
      return;
    }
    if (url === "/v1/tenant/models" && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(catalog));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}` };
}

it(
  "F2-4: configure lists Tenant /models catalog then cancels cleanly",
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "configure-cli-"));
    roots.push(root);
    const host = await startHost();
    const tenantId = newTenantId();
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeLink(root, {
      hostUrl: host.url,
      hostId: "host_01habcdefghijklmnopqrstuvw",
      tenantId,
    });
    await writeCredentials(root, {
      applicationKey: "ab".repeat(32),
      principalId: "pr_test",
    });
    const child = spawn(process.execPath, [cli, "configure"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MODEL_PROVIDER_API_KEY: "" },
    });
    let text = "";
    child.stdout!.on("data", (data) => {
      text += data;
      if (text.includes("Choose a provider:")) {
        child.kill("SIGINT");
      }
    });
    child.stderr!.on("data", (data) => {
      text += data;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(text).toContain("0. Custom OpenAI-compatible provider");
    expect(text).toContain("1. OpenAI (openai)");
    // SIGINT may surface as 130, 143, null, or 1 depending on timing.
    expect([0, 1, 130, 143, null]).toContain(code);
  },
);

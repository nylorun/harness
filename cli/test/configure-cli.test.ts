import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
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
  let model: unknown = { configured: false };
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
    if (url === "/v1/tenant/model" && request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      model = {
        configured: true,
        provider: body.provider,
        model: body.model,
        authType: body.auth?.type ?? "api_key",
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(model));
      return;
    }
    if (url === "/v1/tenant/model" && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(model));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    getModel: () => model,
  };
}

async function run(
  answer: (text: string, child: ReturnType<typeof spawn>) => void,
) {
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
    env: {
      ...process.env,
      MODEL_PROVIDER_API_KEY: "",
    },
  });
  let text = "";
  child.stdout!.on("data", (data) => {
    text += data;
    answer(text, child);
  });
  child.stderr!.on("data", (data) => {
    text += data;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return {
      root,
      code,
      text,
      runtimeUrl: host.url,
      serverKey: "ab".repeat(32),
      tenantId,
      getModel: host.getModel,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tenantHeaders(key: string, tenantId: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
}

it(
  "F2-4: configures a custom provider using Tenant /models catalog",
  { timeout: 20_000 },
  async () => {
    let step = 0;
    const result = await run((text, child) => {
      if (step === 0 && text.includes("Choose a provider:")) {
        step = 1;
        child.stdin!.write("0\n");
      } else if (step === 1 && text.includes("OpenAI-compatible base URL:")) {
        step = 2;
        child.stdin!.write("http://127.0.0.1:9\n");
      } else if (step === 2 && text.includes("Model id:")) {
        step = 3;
        child.stdin!.write("local-model\n");
      } else if (step === 3 && text.toLowerCase().includes("api key")) {
        step = 4;
        child.stdin!.write("test-key\n");
      }
    });
    expect(result.code).toBe(0);
    expect(result.text).toContain("0. Custom OpenAI-compatible provider");
    expect(result.text).toContain("Provider configuration saved.");
    const view = result.getModel() as {
      configured: boolean;
      provider: string;
      model: string;
      baseUrl?: string;
    };
    expect(view).toMatchObject({
      configured: true,
      provider: "custom",
      model: "local-model",
      baseUrl: "http://127.0.0.1:9",
    });
    // Confirm Tenant model route is what was written.
    const response = await fetch(`${result.runtimeUrl}/v1/tenant/model`, {
      headers: tenantHeaders(result.serverKey, result.tenantId),
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({
      configured: true,
      provider: "custom",
      model: "local-model",
    });
  },
);

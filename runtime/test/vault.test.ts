import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { startRuntime, type CoreRuntime } from "../src/core/runtime.js";

const KEK = Buffer.alloc(32, 9).toString("base64");
const ADA_TOKEN = "ada-vault-plaintext-token-7f3c9a2e";
const BAO_TOKEN = "bao-vault-plaintext-token-91ab44c0";
const URL = "https://mcp.example.com/github";

const server = {
  authorization: "Bearer server-token-value",
  "content-type": "application/json",
};
const executor = {
  authorization: "Bearer executor-token-value",
  "content-type": "application/json",
};

async function boot(
  directory: string,
  options: { vaultKek?: string | null; vaultFetch?: typeof fetch } = {},
) {
  return startRuntime({
    sqlitePath: join(directory, "runtime.sqlite"),
    serverToken: "server-token-value",
    executors: [
      {
        token: "executor-token-value",
        agentId: "bot",
        implementationVersion: "dev",
      },
    ],
    vaultKek: options.vaultKek === undefined ? KEK : options.vaultKek,
    vaultFetch: options.vaultFetch,
    port: 0,
  });
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() };
}

it("stores bearer credentials without returning or persisting the plaintext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vault-bearer-"));
  const runtime = await boot(directory);
  try {
    const created = await json(
      await fetch(`${runtime.url}/v1/vaults`, {
        method: "POST",
        headers: server,
        body: JSON.stringify({
          requestId: "vault-1",
          idempotencyKey: "vault-ada",
          name: "GitHub",
          ownerUserId: "ada",
        }),
      }),
    );
    expect(created.status).toBe(200);
    const vaultId = (created.body as { id: string }).id;
    const credential = await json(
      await fetch(`${runtime.url}/v1/vaults/${vaultId}/credentials`, {
        method: "POST",
        headers: server,
        body: JSON.stringify({
          requestId: "cred-1",
          idempotencyKey: "cred-ada",
          name: "GitHub token",
          auth: { type: "bearer", url: URL, token: ADA_TOKEN },
        }),
      }),
    );
    expect(credential.status).toBe(200);
    expect(JSON.stringify(credential.body)).not.toContain(ADA_TOKEN);
    const read = await json(
      await fetch(
        `${runtime.url}/v1/vaults/${vaultId}/credentials/${(credential.body as { id: string }).id}`,
        { headers: server },
      ),
    );
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(ADA_TOKEN);
    expect(read.body).toMatchObject({
      type: "bearer",
      binding: { url: URL },
      vaultId,
    });
    const replay = await json(
      await fetch(`${runtime.url}/v1/vaults`, {
        method: "POST",
        headers: server,
        body: JSON.stringify({
          requestId: "vault-1b",
          idempotencyKey: "vault-ada",
          name: "GitHub",
          ownerUserId: "ada",
        }),
      }),
    );
    expect(replay.body).toMatchObject({ id: vaultId });
    const conflict = await json(
      await fetch(`${runtime.url}/v1/vaults`, {
        method: "POST",
        headers: server,
        body: JSON.stringify({
          requestId: "vault-1c",
          idempotencyKey: "vault-ada",
          name: "Other",
          ownerUserId: "ada",
        }),
      }),
    );
    expect(conflict.status).toBe(409);
    const rejected = await json(
      await fetch(`${runtime.url}/v1/vaults`, {
        method: "POST",
        headers: executor,
        body: JSON.stringify({
          requestId: "vault-x",
          idempotencyKey: "vault-x",
          name: "GitHub",
          ownerUserId: "ada",
        }),
      }),
    );
    expect(rejected.status).toBe(403);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps ciphertext unreadable without the key-encryption key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vault-kek-"));
  const runtime = await boot(directory);
  let vaultId = "";
  let credentialId = "";
  try {
    vaultId = (
      (await json(
        await fetch(`${runtime.url}/v1/vaults`, {
          method: "POST",
          headers: server,
          body: JSON.stringify({
            requestId: "v",
            idempotencyKey: "v",
            name: "GitHub",
            ownerUserId: "ada",
          }),
        }),
      )).body as { id: string }
    ).id;
    credentialId = (
      (await json(
        await fetch(`${runtime.url}/v1/vaults/${vaultId}/credentials`, {
          method: "POST",
          headers: server,
          body: JSON.stringify({
            requestId: "c",
            idempotencyKey: "c",
            name: "token",
            auth: { type: "bearer", url: URL, token: ADA_TOKEN },
          }),
        }),
      )).body as { id: string }
    ).id;
  } finally {
    await runtime.close();
  }
  const files = ["runtime.sqlite", "runtime.sqlite-wal", "runtime.sqlite-shm"];
  for (const name of files) {
    const path = join(directory, name);
    if (existsSync(path))
      expect(readFileSync(path).includes(Buffer.from(ADA_TOKEN))).toBe(false);
  }
  await expect(
    boot(directory, { vaultKek: null }),
  ).rejects.toThrow(/key-encryption key/);
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  db.prepare(`UPDATE vault_credentials SET binding_json=? WHERE id=?`).run(
    JSON.stringify({ url: "https://mcp.example.com/other" }),
    credentialId,
  );
  db.close();
  const again = await boot(directory);
  try {
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    expect(
      (
        await fetch(`${again.url}/v1/agents/bot`, {
          method: "PUT",
          headers: server,
          body: JSON.stringify({
            requestId: "agent",
            manifest: agent.manifest,
            implementationVersion: "dev",
          }),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await fetch(`${again.url}/v1/sessions/s-ada`, {
          method: "PUT",
          headers: server,
          body: JSON.stringify({
            requestId: "session",
            agentId: "bot",
            ownerUserId: "ada",
            vaultIds: [vaultId],
          }),
        })
      ).ok,
    ).toBe(true);
    const refused = await again.authorize("s-ada", {
      url: "https://mcp.example.com/other",
    });
    expect(refused.status).toBe("refused");
    expect(JSON.stringify(refused)).not.toContain(ADA_TOKEN);
  } finally {
    await again.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("attaches only the session user's vaults and selects among matching urls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vault-select-"));
  const runtime = await boot(directory);
  try {
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    expect(
      (
        await fetch(`${runtime.url}/v1/agents/bot`, {
          method: "PUT",
          headers: server,
          body: JSON.stringify({
            requestId: "agent",
            manifest: agent.manifest,
            implementationVersion: "dev",
          }),
        })
      ).ok,
    ).toBe(true);
    const adaVault = await createBearer(runtime, "ada", "ada-vault", ADA_TOKEN);
    const baoVault = await createBearer(runtime, "bao", "bao-vault", BAO_TOKEN);
    const second = await json(
      await fetch(`${runtime.url}/v1/vaults/${adaVault.vaultId}/credentials`, {
        method: "POST",
        headers: server,
        body: JSON.stringify({
          requestId: "ada-2",
          idempotencyKey: "ada-2",
          name: "GitHub other",
          auth: {
            type: "bearer",
            url: URL,
            token: "ada-second-plaintext-token-22ee",
          },
        }),
      }),
    );
    const secondId = (second.body as { id: string }).id;
    const foreign = await json(
      await fetch(`${runtime.url}/v1/sessions/s-ada`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "s",
          agentId: "bot",
          ownerUserId: "ada",
          vaultIds: [baoVault.vaultId],
        }),
      }),
    );
    expect(foreign.status).toBe(403);
    const session = await json(
      await fetch(`${runtime.url}/v1/sessions/s-ada`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "s2",
          agentId: "bot",
          ownerUserId: "ada",
          vaultIds: [adaVault.vaultId],
        }),
      }),
    );
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ vaultIds: [adaVault.vaultId] });
    expect(
      await runtime.authorize("s-ada", { url: "https://mcp.example.com/other" }),
    ).toMatchObject({ status: "unauthenticated", headers: {} });
    const ambiguous = await runtime.authorize("s-ada", {
      url: URL,
      serverName: "github",
    });
    expect(ambiguous.status).toBe("refused");
    if (ambiguous.status === "refused")
      expect(ambiguous.credentialIds.sort()).toEqual(
        [adaVault.credentialId, secondId].sort(),
      );
    const selected = await json(
      await fetch(`${runtime.url}/v1/sessions/s-ada`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "s3",
          agentId: "bot",
          ownerUserId: "ada",
          vaultIds: [adaVault.vaultId],
          credentialSelections: [
            { serverName: "github", credentialId: secondId },
          ],
        }),
      }),
    );
    expect(selected.status).toBe(200);
    const authorized = await runtime.authorize("s-ada", {
      url: URL,
      serverName: "github",
    });
    expect(authorized).toMatchObject({
      status: "authorized",
      headers: { authorization: "Bearer ada-second-plaintext-token-22ee" },
    });
    const baoSession = await json(
      await fetch(`${runtime.url}/v1/sessions/s-bao`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "bao",
          agentId: "bot",
          ownerUserId: "bao",
          vaultIds: [baoVault.vaultId],
        }),
      }),
    );
    expect(baoSession.status).toBe(200);
    expect(await runtime.authorize("s-bao", { url: URL })).toMatchObject({
      status: "authorized",
      headers: { authorization: `Bearer ${BAO_TOKEN}` },
    });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("refreshes an oauth grant only at its token endpoint and does not return the new token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vault-oauth-"));
  const calls: { url: string; body: string }[] = [];
  const runtime = await boot(directory, {
    vaultFetch: (async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({
          access_token: "oauth-access-token-new-88aa",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  try {
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    expect(
      (
        await fetch(`${runtime.url}/v1/agents/bot`, {
          method: "PUT",
          headers: server,
          body: JSON.stringify({
            requestId: "agent",
            manifest: agent.manifest,
            implementationVersion: "dev",
          }),
        })
      ).ok,
    ).toBe(true);
    const vault = await json(
      await fetch(`${runtime.url}/v1/vaults`, {
        method: "POST",
        headers: server,
        body: JSON.stringify({
          requestId: "v",
          idempotencyKey: "v",
          name: "GitHub",
          ownerUserId: "ada",
        }),
      }),
    );
    const vaultId = (vault.body as { id: string }).id;
    const credential = await json(
      await fetch(`${runtime.url}/v1/vaults/${vaultId}/credentials`, {
        method: "POST",
        headers: server,
        body: JSON.stringify({
          requestId: "c",
          idempotencyKey: "c",
          name: "oauth",
          auth: {
            type: "oauth",
            url: URL,
            accessToken: "oauth-access-token-old-11bb",
            expiresAt: new Date(Date.now() - 1000).toISOString(),
            refresh: {
              tokenEndpoint: "https://auth.example.com/token",
              clientId: "client",
              refreshToken: "oauth-refresh-token-33cc",
              tokenEndpointAuth: { type: "none" },
            },
          },
        }),
      }),
    );
    const credentialId = (credential.body as { id: string }).id;
    expect(
      (
        await fetch(`${runtime.url}/v1/sessions/s1`, {
          method: "PUT",
          headers: server,
          body: JSON.stringify({
            requestId: "s",
            agentId: "bot",
            ownerUserId: "ada",
            vaultIds: [vaultId],
          }),
        })
      ).ok,
    ).toBe(true);
    const authorized = await runtime.authorize("s1", { url: URL });
    expect(authorized).toMatchObject({
      status: "authorized",
      headers: { authorization: "Bearer oauth-access-token-new-88aa" },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.example.com/token",
    ]);
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
    const read = await json(
      await fetch(
        `${runtime.url}/v1/vaults/${vaultId}/credentials/${credentialId}`,
        { headers: server },
      ),
    );
    expect(JSON.stringify(read.body)).not.toContain("oauth-access-token-new-88aa");
    expect(JSON.stringify(read.body)).not.toContain("oauth-refresh-token-33cc");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps the host model credential out of user vaults and responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vault-host-model-"));
  const runtime = await boot(directory);
  const secret = "host-model-plaintext-key-77ab";
  try {
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    expect(
      (
        await fetch(`${runtime.url}/v1/agents/bot`, {
          method: "PUT",
          headers: server,
          body: JSON.stringify({
            requestId: "agent",
            manifest: agent.manifest,
            implementationVersion: "dev",
          }),
        })
      ).ok,
    ).toBe(true);
    expect(
      (await json(await fetch(`${runtime.url}/v1/host/model`, { headers: server })))
        .body,
    ).toEqual({ configured: false });
    expect(
      (
        await fetch(`${runtime.url}/v1/host/model`, { headers: executor })
      ).status,
    ).toBe(403);
    const body = {
      requestId: "host-1",
      idempotencyKey: "host-model",
      provider: "custom",
      model: "fixture",
      baseUrl: "https://models.example.test/v1",
      auth: { type: "api_key", key: secret },
    };
    const saved = await json(
      await fetch(`${runtime.url}/v1/host/model`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify(body),
      }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      provider: "custom",
      model: "fixture",
      authType: "api_key",
      baseUrl: "https://models.example.test/v1",
    });
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    const replay = await json(
      await fetch(`${runtime.url}/v1/host/model`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({ ...body, requestId: "host-2" }),
      }),
    );
    expect(replay.body).toEqual(saved.body);
    const conflict = await json(
      await fetch(`${runtime.url}/v1/host/model`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({ ...body, model: "other" }),
      }),
    );
    expect(conflict.status).toBe(409);
    const catalog = await json(
      await fetch(`${runtime.url}/v1/host/models`, { headers: server }),
    );
    expect(JSON.stringify(catalog.body)).not.toContain(secret);
    expect(
      (
        await json(
          await fetch(`${runtime.url}/v1/vaults?ownerUserId=host`, {
            headers: server,
          }),
        )
      ).body,
    ).toEqual({ vaults: [] });
    const listed = await json(
      await fetch(`${runtime.url}/v1/host/providers`, { headers: server }),
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      providers: [
        {
          id: "custom",
          name: "Custom OpenAI-compatible",
          model: "fixture",
          authType: "api_key",
          active: true,
        },
      ],
    });
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    const second = await json(
      await fetch(`${runtime.url}/v1/host/model`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "host-3",
          idempotencyKey: "host-model-second",
          provider: "custom",
          model: "other-fixture",
          baseUrl: "https://models.example.test/v2",
          auth: { type: "api_key", key: `${secret}-2` },
        }),
      }),
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      configured: true,
      provider: "custom",
      model: "other-fixture",
    });
    const afterSecond = await json(
      await fetch(`${runtime.url}/v1/host/providers`, { headers: server }),
    );
    expect(afterSecond.body).toMatchObject({
      providers: [
        {
          id: "custom",
          model: "other-fixture",
          active: true,
        },
      ],
    });
    const openai = await json(
      await fetch(`${runtime.url}/v1/host/model`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "host-4",
          idempotencyKey: "host-model-openai",
          provider: "openai",
          model: (
            (catalog.body as { providers: { id: string; models: { id: string }[] }[] })
              .providers.find((provider) => provider.id === "openai")
              ?.models[0]?.id ?? "gpt-4o-mini"
          ),
          auth: { type: "api_key", key: `${secret}-openai` },
        }),
      }),
    );
    expect(openai.status).toBe(200);
    expect(openai.body).toMatchObject({
      configured: true,
      provider: "openai",
    });
    const both = await json(
      await fetch(`${runtime.url}/v1/host/providers`, { headers: server }),
    );
    expect(
      (both.body as { providers: { id: string; active: boolean }[] }).providers
        .map((provider) => provider.id)
        .sort(),
    ).toEqual(["custom", "openai"]);
    expect(
      (both.body as { providers: { id: string; active: boolean }[] }).providers.find(
        (provider) => provider.id === "openai",
      )?.active,
    ).toBe(true);
    const selected = await json(
      await fetch(`${runtime.url}/v1/host/model/selection`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "host-5",
          idempotencyKey: "host-model-select-custom",
          provider: "custom",
          model: "other-fixture",
          baseUrl: "https://models.example.test/v2",
        }),
      }),
    );
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({
      configured: true,
      provider: "custom",
      model: "other-fixture",
    });
    expect(JSON.stringify(selected.body)).not.toContain(secret);
    const attached = await json(
      await fetch(`${runtime.url}/v1/sessions/s-host`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "session",
          agentId: "bot",
          ownerUserId: "ada",
          vaultIds: ["host"],
        }),
      }),
    );
    expect(attached.status).toBe(400);
  } finally {
    await runtime.close();
    const db = new DatabaseSync(join(directory, "runtime.sqlite"));
    const stored = JSON.stringify(
      db.prepare("SELECT binding_json, ciphertext FROM vault_credentials").all(),
    );
    db.close();
    expect(stored).not.toContain(secret);
    await rm(directory, { recursive: true, force: true });
  }
});

it("adds vault scope to a database created before host credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vault-scope-"));
  const path = join(directory, "old.sqlite");
  const created = new DatabaseSync(path);
  created.exec(
    `CREATE TABLE vaults(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    )`,
  );
  created.close();
  const { Store } = await import("../src/core/store.js");
  const store = new Store(path);
  const columns = store.db.prepare("PRAGMA table_info(vaults)").all() as {
    name: string;
  }[];
  expect(columns.map((column) => column.name)).toContain("scope");
  store.db.close();
  await rm(directory, { recursive: true, force: true });
});

async function createBearer(
  runtime: CoreRuntime & { url: string },
  ownerUserId: string,
  key: string,
  token: string,
) {
  const vault = await json(
    await fetch(`${runtime.url}/v1/vaults`, {
      method: "POST",
      headers: server,
      body: JSON.stringify({
        requestId: `${key}-vault`,
        idempotencyKey: `${key}-vault`,
        name: "GitHub",
        ownerUserId,
      }),
    }),
  );
  const vaultId = (vault.body as { id: string }).id;
  const credential = await json(
    await fetch(`${runtime.url}/v1/vaults/${vaultId}/credentials`, {
      method: "POST",
      headers: server,
      body: JSON.stringify({
        requestId: `${key}-cred`,
        idempotencyKey: `${key}-cred`,
        name: "token",
        auth: { type: "bearer", url: URL, token },
      }),
    }),
  );
  return { vaultId, credentialId: (credential.body as { id: string }).id };
}

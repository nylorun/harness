import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/agents";
import {
  createProjectTenant,
  hashCredential,
  generateBootstrap,
} from "../../src/project/create-tenant.js";
import { readCredentials } from "../../src/project/credentials.js";
import { readLink } from "../../src/project/link.js";

const roots: string[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("hashes credentials with SHA-256 hex", () => {
  const token = "abc";
  expect(hashCredential(token)).toBe(
    createHash("sha256").update(token, "utf8").digest("hex"),
  );
});

it("F2: creates Tenant, writes link+credentials only after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-create-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"create-demo"}');
  const createdIds: string[] = [];
  const server = createServer(async (request, response) => {
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/admin/tenants");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    expect(body.credentialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.credentialHash).not.toBe(body.applicationKey);
    createdIds.push(body.tenantId);
    response.statusCode = 201;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: body.tenantId,
        name: body.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as { port: number }).port;
  const result = await createProjectTenant({
    hostUrl: `http://127.0.0.1:${port}`,
    hostId: "host_01habcdefghijklmnopqrstuv",
    adminKey: randomBytes(32).toString("hex"),
    projectRoot: root,
  });
  expect(result.created).toBe(true);
  expect(result.envelope.name).toBe("create-demo");
  expect(await readLink(root)).toEqual(result.link);
  expect(await readCredentials(root)).toEqual(result.credentials);
  expect(createdIds).toEqual([result.link.tenantId]);
});

it("F2: regenerates id on 409 collision up to three times", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-collide-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"collide"}');
  let attempts = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    attempts += 1;
    if (attempts < 3) {
      response.statusCode = 409;
      response.end(JSON.stringify({ status: "rejected", code: "conflict" }));
      return;
    }
    response.statusCode = 201;
    response.end(
      JSON.stringify({
        id: body.tenantId,
        name: body.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as { port: number }).port;
  const result = await createProjectTenant({
    hostUrl: `http://127.0.0.1:${port}`,
    hostId: "host_01habcdefghijklmnopqrstuv",
    adminKey: "a".repeat(64),
    projectRoot: root,
  });
  expect(attempts).toBe(3);
  expect(result.link.tenantId).toMatch(/^tn_/);
});

it("F2: retries lost response with identical material", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-retry-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"retry"}');
  const bodies: unknown[] = [];
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    bodies.push(body);
    calls += 1;
    if (calls === 1) {
      // Simulate a lost response: abort without completing.
      request.socket.destroy();
      return;
    }
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        id: body.tenantId,
        name: body.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as { port: number }).port;
  const result = await createProjectTenant({
    hostUrl: `http://127.0.0.1:${port}`,
    hostId: "host_01habcdefghijklmnopqrstuv",
    adminKey: "a".repeat(64),
    projectRoot: root,
  });
  expect(calls).toBe(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(result.created).toBe(false);
});

it("generateBootstrap produces valid ids", () => {
  const material = generateBootstrap("demo");
  expect(material.tenantId).toMatch(/^tn_/);
  expect(material.applicationKey).toHaveLength(64);
  expect(material.principalId).toMatch(/^principal_/);
  expect(material.idempotencyKey.length).toBeGreaterThan(8);
  void newTenantId;
});

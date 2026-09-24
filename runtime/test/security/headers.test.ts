/**
 * G5 — Header rules (missing → 400 before FS; query/body cannot override).
 */
import { expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { PROTOCOL_HEADER, TENANT_HEADER } from "@nylorun/core/compatibility";
import {
  getJson,
  protocolHeaders,
  startSecurityHost,
} from "./support.js";

it("G5: missing Nylorun-Tenant returns 400 before filesystem access", async () => {
  const host = await startSecurityHost();
  const realpathSpy = vi.spyOn(fs, "realpathSync");
  const readSpy = vi.spyOn(fs, "readFileSync");
  const callsBefore = realpathSpy.mock.calls.length + readSpy.mock.calls.length;

  const { status, body } = await getJson(`${host.url}/v1/agents`, {
    headers: protocolHeaders({
      authorization: `Bearer ${host.tenants[0].applicationKey}`,
    }),
  });
  expect(status).toBe(400);
  expect(body).toMatchObject({
    status: "rejected",
    code: "invalid_request",
  });

  const callsAfter = realpathSpy.mock.calls.length + readSpy.mock.calls.length;
  expect(callsAfter).toBe(callsBefore);
  realpathSpy.mockRestore();
  readSpy.mockRestore();
});

it("G5: malformed Nylorun-Tenant returns 400 before resolve/FS", async () => {
  const host = await startSecurityHost();
  const resolve = vi.spyOn(host.module, "resolve");
  const realpathSpy = vi.spyOn(fs, "realpathSync");
  const before = realpathSpy.mock.calls.length;

  const { status } = await getJson(`${host.url}/v1/agents`, {
    headers: protocolHeaders({
      [TENANT_HEADER]: "not-a-tenant-id",
      authorization: `Bearer ${host.tenants[0].applicationKey}`,
    }),
  });
  expect(status).toBe(400);
  expect(resolve).not.toHaveBeenCalled();
  expect(realpathSpy.mock.calls.length).toBe(before);
  resolve.mockRestore();
  realpathSpy.mockRestore();
});

it("G5: Tenant header cannot be overridden by query or body", async () => {
  const host = await startSecurityHost();
  const [a, b] = host.tenants;
  const { status, body } = await getJson(
    `${host.url}/v1/tenant?${TENANT_HEADER}=${b.id}&tenant=${b.id}`,
    {
      method: "GET",
      headers: {
        ...a.headers(),
        // body ignored on GET; also try POST-style confusion on a GET route
      },
    },
  );
  expect(status).toBe(200);
  expect(body).toMatchObject({
    tenant: expect.objectContaining({ id: a.id }),
  });
  expect(JSON.stringify(body)).not.toContain(b.id);

  const post = await getJson(`${host.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: a.headers(),
    body: JSON.stringify({
      requestId: "seed-header-override",
      tenant: b.id,
      [TENANT_HEADER]: b.id,
      sandbox: { backend: "virtual" },
    }),
  });
  // Seed may apply or keep; either way it must be A's Tenant (not B).
  expect([200, 400]).toContain(post.status);
  const aStatus = await getJson(`${host.url}/v1/tenant`, {
    headers: a.headers(),
  });
  expect(aStatus.status).toBe(200);
  expect((aStatus.body as { tenant: { id: string } }).tenant.id).toBe(a.id);
  void PROTOCOL_HEADER;
});

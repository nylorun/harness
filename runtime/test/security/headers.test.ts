/**
 * G5 — Header rules (missing → 400 before selection/FS; query/body cannot override).
 */
import { expect, it, vi } from "vitest";
import { TENANT_HEADER } from "@nylorun/core/compatibility";
import * as paths from "../../src/tenant/paths.js";
import {
  getJson,
  protocolHeaders,
  startSecurityHost,
} from "./support.js";

it("G5: missing Nylorun-Tenant returns 400 before resolve or tenantPaths", async () => {
  const host = await startSecurityHost();
  const resolve = vi.spyOn(host.module, "resolve");
  // ESM `node:fs` exports are not configurable; spy the path helper Host/module use.
  const tenantPathsSpy = vi.spyOn(paths, "tenantPaths");
  const before = tenantPathsSpy.mock.calls.length;

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
  expect(resolve).not.toHaveBeenCalled();
  expect(tenantPathsSpy.mock.calls.length).toBe(before);
  resolve.mockRestore();
  tenantPathsSpy.mockRestore();
});

it("G5: malformed Nylorun-Tenant returns 400 before resolve or tenantPaths", async () => {
  const host = await startSecurityHost();
  const resolve = vi.spyOn(host.module, "resolve");
  const tenantPathsSpy = vi.spyOn(paths, "tenantPaths");
  const before = tenantPathsSpy.mock.calls.length;

  const { status } = await getJson(`${host.url}/v1/agents`, {
    headers: protocolHeaders({
      [TENANT_HEADER]: "not-a-tenant-id",
      authorization: `Bearer ${host.tenants[0].applicationKey}`,
    }),
  });
  expect(status).toBe(400);
  expect(resolve).not.toHaveBeenCalled();
  expect(tenantPathsSpy.mock.calls.length).toBe(before);
  resolve.mockRestore();
  tenantPathsSpy.mockRestore();
});

it("G5: Tenant header cannot be overridden by query or body", async () => {
  const host = await startSecurityHost();
  const [a, b] = host.tenants;
  const { status, body } = await getJson(
    `${host.url}/v1/tenant?${TENANT_HEADER}=${b.id}&tenant=${b.id}`,
    {
      method: "GET",
      headers: a.headers(),
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
  expect([200, 400]).toContain(post.status);
  const aStatus = await getJson(`${host.url}/v1/tenant`, {
    headers: a.headers(),
  });
  expect(aStatus.status).toBe(200);
  expect((aStatus.body as { tenant: { id: string } }).tenant.id).toBe(a.id);
});

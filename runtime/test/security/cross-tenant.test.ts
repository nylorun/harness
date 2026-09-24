/**
 * G4 — Cross-Tenant fuzz for every §5.3 Tenant route family.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/agents";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";
import {
  getJson,
  startSecurityHost,
  tenantHeaders,
} from "./support.js";

const agentA = Agent({ id: "agent-a", name: "A" }).build();
const agentB = Agent({ id: "agent-b", name: "B" }).build();

it("G4: cross-Tenant ids and credentials never leak or mutate the other Tenant", async () => {
  const host = await startSecurityHost({
    sandboxBackend: "virtual",
    model: { kind: "scripted", output: "ok" },
  });
  const [a, b] = host.tenants;

  // Seed distinct resources in each Tenant.
  for (const [tenant, agent, sessionId] of [
    [a, agentA, "sess-a"] as const,
    [b, agentB, "sess-b"] as const,
  ]) {
    expect(
      (
        await getJson(`${host.url}/v1/agents/${agent.manifest.id}`, {
          method: "PUT",
          headers: tenant.headers(),
          body: JSON.stringify({
            requestId: randomUUID(),
            implementationVersion: "dev",
            manifest: agent.manifest,
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await getJson(`${host.url}/v1/sessions/${sessionId}`, {
          method: "PUT",
          headers: tenant.headers(),
          body: JSON.stringify({
            requestId: randomUUID(),
            agentId: agent.manifest.id,
            ownerUserId: "user-1",
          }),
        })
      ).status,
    ).toBe(200);
    const vault = await getJson(`${host.url}/v1/vaults`, {
      method: "POST",
      headers: tenant.headers(),
      body: JSON.stringify({
        requestId: randomUUID(),
        idempotencyKey: `vault-${tenant.id}`,
        name: `Vault ${tenant.name}`,
        ownerUserId: "user-1",
      }),
    });
    expect(vault.status).toBe(200);
    (tenant as { vaultId?: string }).vaultId = (
      vault.body as { id: string }
    ).id;
  }

  const vaultA = (a as { vaultId?: string }).vaultId!;
  const vaultB = (b as { vaultId?: string }).vaultId!;

  const routes: Array<{
    label: string;
    init: RequestInit & { path: string };
    expectOpaque?: boolean;
    expectAScoped?: boolean;
  }> = [
    {
      label: "A header + B token → opaque",
      init: {
        path: "/v1/agents",
        headers: tenantHeaders(a.id, b.applicationKey),
      },
      expectOpaque: true,
    },
    {
      label: "B header + A token → opaque",
      init: {
        path: "/v1/agents",
        headers: tenantHeaders(b.id, a.applicationKey),
      },
      expectOpaque: true,
    },
    {
      label: "A auth + B session id → A-scoped miss",
      init: {
        path: "/v1/sessions/sess-b",
        headers: a.headers(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B agent id list still A-only",
      init: {
        path: "/v1/agents",
        headers: a.headers(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B vault id",
      init: {
        path: `/v1/vaults/${vaultB}`,
        headers: a.headers(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B tenant status path is still A",
      init: {
        path: "/v1/tenant",
        headers: a.headers(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B model route",
      init: {
        path: "/v1/tenant/model",
        headers: a.headers(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth + B sandbox route",
      init: {
        path: "/v1/tenant/sandbox",
        headers: a.headers(),
      },
      expectAScoped: true,
    },
    {
      label: "A auth reading B action id",
      init: {
        path: "/v1/actions/action-from-b",
        headers: a.headers(),
      },
      expectAScoped: true,
    },
    {
      label: "B header with A session path → opaque (wrong credential)",
      init: {
        path: "/v1/sessions/sess-a",
        headers: tenantHeaders(b.id, a.applicationKey),
      },
      expectOpaque: true,
    },
  ];

  for (const route of routes) {
    const result = await getJson(`${host.url}${route.init.path}`, {
      method: route.init.method ?? "GET",
      headers: route.init.headers,
      body: route.init.body,
    });
    if (route.expectOpaque) {
      expect(result.status, route.label).toBe(404);
      expect(result.body, route.label).toEqual(OPAQUE_NOT_FOUND);
      continue;
    }
    // A-scoped: either success that only reflects A, or a non-leak 404/403/400.
    expect([200, 400, 403, 404], route.label).toContain(result.status);
    if (result.status === 200) {
      const text = result.raw;
      expect(text, route.label).not.toContain(b.id);
      expect(text, route.label).not.toContain("sess-b");
      expect(text, route.label).not.toContain(vaultB);
      expect(text, route.label).not.toContain(agentB.manifest.id);
      if (route.init.path === "/v1/agents") {
        expect(text).toContain(agentA.manifest.id);
      }
      if (route.init.path === "/v1/tenant") {
        expect(text).toContain(a.id);
      }
    } else if (result.status === 404) {
      // Misses inside A must not reveal B's existence via a distinct body.
      expect(result.raw, route.label).not.toContain(b.id);
      expect(result.raw, route.label).not.toContain(vaultB);
    }
  }

  // Positive control: A can still read its own vault/session.
  const ownSession = await getJson(`${host.url}/v1/sessions/sess-a`, {
    headers: a.headers(),
  });
  expect(ownSession.status).toBe(200);
  const ownVault = await getJson(`${host.url}/v1/vaults/${vaultA}`, {
    headers: a.headers(),
  });
  expect(ownVault.status).toBe(200);

  // B still has its own session after the fuzz.
  const bSession = await getJson(`${host.url}/v1/sessions/sess-b`, {
    headers: b.headers(),
  });
  expect(bSession.status).toBe(200);
});

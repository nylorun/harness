import { expect, it } from "vitest";
import { newTenantId } from "@nylorun/agents";
import { matchTenant } from "../../src/tenant/commands.js";
import type { AdminTenant } from "@nylorun/admin";

function tenant(
  name: string | null,
  id = newTenantId(),
): AdminTenant {
  return {
    id,
    name,
    state: "open",
    envelope: name
      ? {
          id,
          name,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        }
      : null,
  };
}

it("matches exact unique name or id", () => {
  const a = tenant("alpha");
  const b = tenant("beta");
  const tenants = [a, b];
  expect(matchTenant(tenants, "alpha").id).toBe(a.id);
  expect(matchTenant(tenants, a.id).id).toBe(a.id);
  expect(() => matchTenant(tenants, "missing")).toThrow("No Tenant named");
});

it("rejects ambiguous names", () => {
  const id1 = newTenantId();
  const id2 = newTenantId();
  const tenants = [tenant("dup", id1), tenant("dup", id2)];
  expect(() => matchTenant(tenants, "dup")).toThrow("not unique");
});

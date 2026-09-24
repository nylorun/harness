/**
 * G6 — Indistinguishability of unknown / quarantined / credential-rejected.
 */
import { expect, it } from "vitest";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";
import {
  createFakeModule,
  getJson as hostGetJson,
  newTenantId,
  startTestHost,
  tenantHeaders as hostTenantHeaders,
} from "../host/support.js";
import {
  comparableHeaders,
  getRaw,
  startSecurityHost,
  tenantHeaders,
} from "./support.js";

it("G6: unknown and quarantined Host responses are byte-identical", async () => {
  const openId = newTenantId();
  const quarantinedId = newTenantId();
  const module = createFakeModule({
    tenants: [
      { id: openId, name: "open", state: "open" },
      {
        id: quarantinedId,
        name: "q",
        state: "quarantined",
        quarantine: {
          code: "locked",
          message: "locked",
          repair: "nylorun tenant status",
          lockPid: 1,
        },
      },
    ],
  });
  const { url } = await startTestHost({ module });

  const unknown = await getRaw(`${url}/v1/agents`, {
    headers: hostTenantHeaders(newTenantId()),
  });
  const quarantined = await getRaw(`${url}/v1/agents`, {
    headers: hostTenantHeaders(quarantinedId),
  });

  expect(unknown.status).toBe(404);
  expect(quarantined.status).toBe(404);
  expect(JSON.parse(unknown.body)).toEqual(OPAQUE_NOT_FOUND);
  expect(unknown.status).toBe(quarantined.status);
  expect(unknown.body).toBe(quarantined.body);
  expect(comparableHeaders(unknown.headers)).toEqual(
    comparableHeaders(quarantined.headers),
  );
});

it("G6: credential-rejected matches unknown/quarantined status, headers, and body", async () => {
  const host = await startSecurityHost();
  const [a, b] = host.tenants;

  const unknown = await getRaw(`${host.url}/v1/agents`, {
    headers: tenantHeaders(newTenantId(), a.applicationKey),
  });
  const rejected = await getRaw(`${host.url}/v1/agents`, {
    headers: tenantHeaders(a.id, b.applicationKey),
  });
  // Quarantine B by closing and replacing with a quarantined fake entry is not
  // available on the real module; compare rejected to unknown (Host opaque path)
  // and assert both equal the frozen D5 body.
  expect(JSON.parse(unknown.body)).toEqual(OPAQUE_NOT_FOUND);
  expect(JSON.parse(rejected.body)).toEqual(OPAQUE_NOT_FOUND);
  expect(unknown.status).toBe(404);
  expect(rejected.status).toBe(404);
  expect(unknown.body).toBe(rejected.body);
  expect(comparableHeaders(unknown.headers)).toEqual(
    comparableHeaders(rejected.headers),
  );

  // Sanity: open Tenant with the correct key still works.
  const ok = await hostGetJson(`${host.url}/v1/agents`, {
    headers: a.headers(),
  });
  expect(ok.status).toBe(200);
});

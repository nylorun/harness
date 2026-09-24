import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  TENANT_ID_PATTERN,
  checkCompatibility,
  isTenantId,
  newTenantId,
} from "../src/compatibility.js";

const CROCKFORD = /^[0-9a-hjkmnp-tv-z]+$/;

describe("tenant ids", () => {
  it("uses the Crockford alphabet, tn_ prefix and length 29", () => {
    const id = newTenantId(1_700_000_000_000);
    expect(id).toMatch(/^tn_/);
    expect(id).toHaveLength(29);
    expect(id.slice(3)).toMatch(CROCKFORD);
    expect(id).toMatch(TENANT_ID_PATTERN);
    expect(isTenantId(id)).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isTenantId("tn_00000000000000000000000000")).toBe(true);
    expect(isTenantId("tn_iiiiiiiiiiiiiiiiiiiiiiiiii")).toBe(false);
    expect(isTenantId("tn_OOOOOOOOOOOOOOOOOOOOOOOOOO")).toBe(false);
    expect(isTenantId("tn_short")).toBe(false);
    expect(isTenantId("host_00000000000000000000000000")).toBe(false);
    expect(isTenantId(null)).toBe(false);
  });

  it("keeps a monotonic time prefix for a fixed clock", () => {
    const earlier = newTenantId(1_000);
    const later = newTenantId(2_000);
    expect(earlier.slice(3, 13) < later.slice(3, 13)).toBe(true);
  });

  it("stays lexicographically monotonic within the same millisecond", () => {
    const ids = Array.from({ length: 32 }, () => newTenantId(42));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
      expect(ids[i]!.slice(3, 13)).toBe(ids[0]!.slice(3, 13));
    }
  });
});

describe("checkCompatibility", () => {
  it("accepts a client inside the host range with required features", () => {
    expect(
      checkCompatibility(
        { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
        HOST_PROTOCOL,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects an out-of-range protocol version", () => {
    expect(
      checkCompatibility({ version: 1, required: [] }, HOST_PROTOCOL),
    ).toEqual({
      ok: false,
      reason: "version",
      client: 1,
      host: HOST_PROTOCOL,
    });
  });

  it("rejects missing required features", () => {
    expect(
      checkCompatibility(
        { version: 2, required: ["runtime-tenants", "missing-feature"] },
        HOST_PROTOCOL,
      ),
    ).toEqual({
      ok: false,
      reason: "feature",
      missing: ["missing-feature"],
      host: HOST_PROTOCOL,
    });
  });
});

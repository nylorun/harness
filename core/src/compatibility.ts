export { hashManifest } from "./utils/hash.js";

export const PROTOCOL_VERSION = 2;
export const PROTOCOL_FEATURES = ["runtime-tenants"] as const;
export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[number];
export interface ProtocolRange {
  min: number;
  max: number;
  features: readonly string[];
}
export const HOST_PROTOCOL: ProtocolRange = {
  min: 2,
  max: 2,
  features: PROTOCOL_FEATURES,
};
export const DEFINITION_SCHEMA_VERSION = 2;

export const TENANT_HEADER = "Nylorun-Tenant";
export const PROTOCOL_HEADER = "Nylorun-Protocol";

/** Crockford Base32 alphabet (lowercase); excludes i, l, o, u. */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
export const TENANT_ID_PATTERN = /^tn_[0-9a-hjkmnp-tv-z]{26}$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID_PATTERN.test(value);
}

function encodeTime(ms: number): string {
  let value = Math.floor(ms);
  if (!Number.isFinite(value) || value < 0) value = 0;
  // ULID time component is 48 bits.
  value = value % 2 ** 48;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  // 80 bits → 16 Crockford chars (5 bits each).
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31]!;
    }
  }
  return out;
}

let lastTime = -1;
let lastRandom = "";

/**
 * Lowercase Crockford ULID with `tn_` prefix; 48-bit time + 80-bit CSPRNG.
 * Same-millisecond calls stay lexicographically monotonic by bumping the random
 * component when the clock does not advance.
 */
export function newTenantId(now?: number): string {
  const ms = now ?? Date.now();
  const time = encodeTime(ms);
  let random = encodeRandom();
  if (ms === lastTime && lastRandom !== "" && random <= lastRandom) {
    random = incrementCrockford(lastRandom);
  }
  lastTime = ms;
  lastRandom = random;
  return `tn_${time}${random}`;
}

function incrementCrockford(value: string): string {
  const chars = [...value];
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = CROCKFORD.indexOf(chars[i]!);
    if (index < 0) continue;
    if (index < 31) {
      chars[i] = CROCKFORD[index + 1]!;
      return chars.join("");
    }
    chars[i] = CROCKFORD[0]!;
  }
  return encodeRandom();
}

export type Compatibility =
  | { ok: true }
  | { ok: false; reason: "version"; client: number; host: ProtocolRange }
  | {
      ok: false;
      reason: "feature";
      missing: readonly string[];
      host: ProtocolRange;
    };

export function checkCompatibility(
  client: { version: number; required: readonly string[] },
  host: ProtocolRange,
): Compatibility {
  if (client.version < host.min || client.version > host.max) {
    return { ok: false, reason: "version", client: client.version, host };
  }
  const advertised = new Set(host.features);
  const missing = client.required.filter((feature) => !advertised.has(feature));
  if (missing.length > 0) {
    return { ok: false, reason: "feature", missing, host };
  }
  return { ok: true };
}

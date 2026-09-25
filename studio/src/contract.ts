/** Shared dashboard–proxy contract. Pure TypeScript; no Node imports. Frozen after Wave 0. */

export const STUDIO_PROTOCOL = 1;
export const SUPPORTED_STUDIO_PROTOCOLS: readonly number[] = [1];
export const HOSTED_ORIGIN = "https://local.nylorun.studio";
export const PROXY_HOST = "127.0.0.1";
export const PAIRING_STORAGE_KEY = "nylorun.studio.pairing.v1";

/** 32 random bytes as base64url are always 43 characters (no padding). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type StudioMode = "hosted" | "local";
export type Pairing = Readonly<{
  protocol: number;
  port: number;
  token: string;
}>;

export type StudioHello = Readonly<{
  studioProtocol: number;
  proxyVersion: string;
  mode: StudioMode;
  tenant?: Readonly<{ id: string; name: string }>;
  runtime: Readonly<{ compatible: boolean; message?: string }>;
}>;

export type VersionsManifest = Readonly<{
  latest: string;
  protocols: Readonly<Record<string, string>>; // protocol → newest build
}>;

/** Builds "#studio=…&port=…&token=…". */
export function pairingFragment(pairing: Pairing): string {
  const params = new URLSearchParams({
    studio: String(pairing.protocol),
    port: String(pairing.port),
    token: pairing.token,
  });
  return `#${params.toString()}`;
}

/**
 * Parses a location.hash. Returns undefined unless studio, port and token are
 * all valid. Extra params (including `host`) are ignored — the proxy address
 * always comes from {@link proxyOrigin}.
 */
export function parsePairingFragment(hash: string): Pairing | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return undefined;

  const params = new URLSearchParams(raw);
  const studioRaw = params.get("studio");
  const portRaw = params.get("port");
  const token = params.get("token");

  if (studioRaw === null || portRaw === null || token === null) return undefined;

  if (!/^-?\d+$/.test(studioRaw)) return undefined;
  const protocol = Number(studioRaw);
  if (!Number.isInteger(protocol)) return undefined;

  if (!/^\d+$/.test(portRaw)) return undefined;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;

  if (!TOKEN_PATTERN.test(token)) return undefined;

  return Object.freeze({ protocol, port, token });
}

/** Always http://127.0.0.1:<port>. Never accepts a host from the caller. */
export function proxyOrigin(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`proxyOrigin: port must be an integer 1–65535, got ${port}`);
  }
  return `http://${PROXY_HOST}:${port}`;
}

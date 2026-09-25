/**
 * Dashboard ↔ local Studio proxy pairing and fetch helpers.
 * Builds every proxy URL as http://127.0.0.1:<port> via the frozen contract.
 */
import { createClient } from "@nylorun/agents/client";
import {
  PAIRING_STORAGE_KEY,
  SUPPORTED_STUDIO_PROTOCOLS,
  pairingFragment,
  parsePairingFragment,
  proxyOrigin,
  type Pairing,
  type StudioHello,
  type VersionsManifest,
} from "../../src/contract.ts";

/** RequestInit plus Chromium Local Network Access hint. */
export type ProxyRequestInit = RequestInit & {
  targetAddressSpace?: "loopback" | "local" | "public";
};

export type ProxyFetch = (
  input: RequestInfo | URL,
  init?: ProxyRequestInit,
) => Promise<Response>;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type HistoryLike = Pick<History, "replaceState">;
type LocationLike = Pick<Location, "hash" | "pathname" | "search" | "origin" | "href">;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** sessionStorage JSON shape (protocol optional for older tabs). */
type StoredPairingJson = Readonly<{
  port: number;
  token: string;
  protocol?: number;
}>;

function parseStoredPairing(raw: string): Pairing | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.port !== "number" || !Number.isInteger(record.port))
    return undefined;
  if (record.port < 1 || record.port > 65535) return undefined;
  if (typeof record.token !== "string" || !TOKEN_PATTERN.test(record.token))
    return undefined;
  const protocol =
    typeof record.protocol === "number" && Number.isInteger(record.protocol)
      ? record.protocol
      : 1;
  return Object.freeze({ protocol, port: record.port, token: record.token });
}

function storePairing(pairing: Pairing, storage: StorageLike): void {
  const payload: StoredPairingJson = {
    port: pairing.port,
    token: pairing.token,
    protocol: pairing.protocol,
  };
  storage.setItem(PAIRING_STORAGE_KEY, JSON.stringify(payload));
}

/**
 * Fragment first, then sessionStorage. On a fragment hit, persists
 * `{ port, token }` (and protocol) and strips the hash with replaceState.
 */
export function readPairing(
  loc: LocationLike = location,
  storage: StorageLike = sessionStorage,
  historyApi: HistoryLike = history,
): Pairing | undefined {
  const fromFragment = parsePairingFragment(loc.hash);
  if (fromFragment) {
    storePairing(fromFragment, storage);
    historyApi.replaceState(null, "", loc.pathname + loc.search);
    return fromFragment;
  }
  const raw = storage.getItem(PAIRING_STORAGE_KEY);
  if (raw === null) return undefined;
  return parseStoredPairing(raw);
}

export function clearPairing(storage: StorageLike = sessionStorage): void {
  storage.removeItem(PAIRING_STORAGE_KEY);
}

export function protocolSupported(protocol: number): boolean {
  return SUPPORTED_STUDIO_PROTOCOLS.includes(protocol);
}

export function currentPairing(
  storage: StorageLike = sessionStorage,
): Pairing | undefined {
  const raw = storage.getItem(PAIRING_STORAGE_KEY);
  if (raw === null) return undefined;
  return parseStoredPairing(raw);
}

function requirePairing(storage: StorageLike = sessionStorage): Pairing {
  const pairing = currentPairing(storage);
  if (!pairing) throw new Error("Studio is not paired with a local proxy.");
  return pairing;
}

/** Absolute URL on the loopback proxy. `path` may be absolute under `/_studio/…`. */
export function proxyUrl(
  path: string,
  pairing: Pairing = requirePairing(),
): string {
  const origin = proxyOrigin(pairing.port);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    throw new Error("proxyUrl only accepts relative proxy paths.");
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${normalized}`;
}

function withProxyAuth(
  pairing: Pairing,
  init?: ProxyRequestInit,
): ProxyRequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${pairing.token}`);
  }
  return {
    ...init,
    headers,
    targetAddressSpace: "loopback",
  };
}

/** Authenticated fetch to the paired loopback proxy. */
export function proxyFetch(
  path: string,
  init?: ProxyRequestInit,
  options?: Readonly<{
    pairing?: Pairing;
    fetcher?: ProxyFetch;
    storage?: StorageLike;
  }>,
): Promise<Response> {
  const pairing = options?.pairing ?? requirePairing(options?.storage);
  const fetcher = options?.fetcher ?? (fetch as ProxyFetch);
  return fetcher(proxyUrl(path, pairing), withProxyAuth(pairing, init));
}

/**
 * SDK client pointed at `http://127.0.0.1:<port>/_studio/runtime` with the
 * proxy token as the bearer key and Local Network Access marked on every fetch.
 */
export function createProxyClient(
  tenantId: string,
  options?: Readonly<{
    pairing?: Pairing;
    fetcher?: ProxyFetch;
    storage?: StorageLike;
  }>,
) {
  const pairing = options?.pairing ?? requirePairing(options?.storage);
  const fetcher = options?.fetcher ?? (fetch as ProxyFetch);
  return createClient({
    url: proxyUrl("/_studio/runtime", pairing),
    key: pairing.token,
    tenant: tenantId,
    fetch: (url, init) =>
      fetcher(url, withProxyAuth(pairing, init as ProxyRequestInit)),
  });
}

export async function fetchHello(
  options?: Readonly<{
    pairing?: Pairing;
    fetcher?: ProxyFetch;
    storage?: StorageLike;
  }>,
): Promise<StudioHello> {
  const response = await proxyFetch("/_studio/hello", undefined, options);
  if (response.status === 401) {
    clearPairing(options?.storage);
    throw new ProxyAuthError();
  }
  if (!response.ok) {
    throw new Error(`Studio hello failed (${response.status}).`);
  }
  return (await response.json()) as StudioHello;
}

export class ProxyAuthError extends Error {
  constructor(message = "Studio proxy rejected the pairing token.") {
    super(message);
    this.name = "ProxyAuthError";
  }
}

/**
 * Look up the newest hosted build for an unsupported protocol.
 * Returns the version string, or undefined when versions.json has no entry.
 */
export function compatibleBuildVersion(
  protocol: number,
  manifest: VersionsManifest,
): string | undefined {
  const version = manifest.protocols[String(protocol)];
  return typeof version === "string" && version.length > 0
    ? version
    : undefined;
}

/**
 * Fetch `/versions.json` from the current origin and replace to a compatible
 * `/v/<version>/`, keeping the pairing fragment. Returns true when navigating.
 */
export async function redirectToCompatibleBuild(
  pairing: Pairing,
  options?: Readonly<{
    loc?: LocationLike & { replace(url: string): void };
    fetcher?: ProxyFetch;
  }>,
): Promise<boolean> {
  const loc = options?.loc ?? location;
  const fetcher = options?.fetcher ?? (fetch as ProxyFetch);
  let manifest: VersionsManifest;
  try {
    const response = await fetcher(new URL("/versions.json", loc.origin).href, {
      cache: "no-store",
    });
    if (!response.ok) return false;
    manifest = (await response.json()) as VersionsManifest;
  } catch {
    return false;
  }
  const version = compatibleBuildVersion(pairing.protocol, manifest);
  if (!version) return false;
  const targetBase = `/v/${version}/`;
  if (loc.pathname.startsWith(targetBase)) return false;
  const fragment = pairingFragment(pairing);
  const next = `${targetBase}${loc.search}${fragment}`;
  if (options?.loc && "replace" in options.loc) {
    options.loc.replace(next);
  } else {
    location.replace(next);
  }
  return true;
}

/** Classify a failed first request for the pairing UI. */
export function classifyProxyFailure(
  cause: unknown,
  secureContext: boolean,
): "auth" | "local-access" | "network" {
  if (cause instanceof ProxyAuthError) return "auth";
  if (
    cause instanceof TypeError &&
    secureContext
  ) {
    return "local-access";
  }
  if (
    cause instanceof Error &&
    /failed to fetch|networkerror|load failed|fetch/i.test(cause.message) &&
    secureContext &&
    cause.name === "TypeError"
  ) {
    return "local-access";
  }
  return "network";
}

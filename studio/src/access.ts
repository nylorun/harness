import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Mints a 256-bit proxy token (P2). */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time token compare. Length mismatch is a failure without calling
 * timingSafeEqual (P2).
 */
export function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type AuthorizeOk = Readonly<{
  ok: true;
  preflight?: false;
  /** Present when the request Origin is in the allowed set. */
  corsOrigin?: string;
}>;

export type AuthorizePreflight = Readonly<{
  ok: true;
  preflight: true;
  headers: Readonly<Record<string, string>>;
}>;

export type AuthorizeDeny = Readonly<{
  ok: false;
  status: number;
  message: string;
  headers?: Readonly<Record<string, string>>;
}>;

export type AuthorizeResult = AuthorizeOk | AuthorizePreflight | AuthorizeDeny;

const SAFE_METHODS = new Set(["GET", "HEAD"]);

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer "))
    return undefined;
  return header.slice("Bearer ".length);
}

/** Exact-origin CORS preflight headers (design §7.3, P3). */
export function preflightHeaders(
  origin: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, PUT, POST, DELETE",
    "access-control-allow-headers":
      "authorization, content-type, accept, last-event-id",
    "access-control-allow-private-network": "true",
    vary: "Origin",
    "access-control-max-age": "600",
  });
}

/** CORS headers for a successful `/_studio/*` response (P3). */
export function studioCorsHeaders(
  corsOrigin: string | undefined,
): Readonly<Record<string, string>> {
  if (corsOrigin === undefined) return Object.freeze({ vary: "Origin" });
  return Object.freeze({
    "access-control-allow-origin": corsOrigin,
    vary: "Origin",
  });
}

/**
 * Shared gate for every `/_studio/*` request (P4). Called before routing so a
 * new route cannot skip authentication or Origin checks.
 */
export function authorize(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
  token: string,
): AuthorizeResult {
  const origin = request.headers.origin;
  const method = (request.method ?? "GET").toUpperCase();

  if (method === "OPTIONS") {
    if (origin === undefined || !allowedOrigins.has(origin)) {
      return Object.freeze({
        ok: false,
        status: 403,
        message: "Origin not allowed",
        headers: Object.freeze({ vary: "Origin" }),
      });
    }
    return Object.freeze({
      ok: true,
      preflight: true,
      headers: preflightHeaders(origin),
    });
  }

  if (origin !== undefined && !allowedOrigins.has(origin)) {
    return Object.freeze({
      ok: false,
      status: 403,
      message: "Origin not allowed",
      headers: Object.freeze({ vary: "Origin" }),
    });
  }

  if (!SAFE_METHODS.has(method) && (origin === undefined || !allowedOrigins.has(origin))) {
    return Object.freeze({
      ok: false,
      status: 403,
      message: "Studio mutations require an allowed Origin",
      headers: Object.freeze({ vary: "Origin" }),
    });
  }

  const provided = bearerToken(request);
  if (provided === undefined || !tokensEqual(token, provided)) {
    return Object.freeze({
      ok: false,
      status: 401,
      message: "Studio proxy token required",
      headers: Object.freeze({
        "www-authenticate": "Bearer",
        vary: "Origin",
      }),
    });
  }

  return Object.freeze({
    ok: true,
    corsOrigin:
      origin !== undefined && allowedOrigins.has(origin) ? origin : undefined,
  });
}

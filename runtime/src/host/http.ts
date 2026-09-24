import type { ServerResponse } from "node:http";
import {
  HOST_PROTOCOL,
  type ProtocolRange,
} from "@nylorun/core/compatibility";

export const OPAQUE_NOT_FOUND = {
  status: "rejected" as const,
  code: "not_found" as const,
  message: "Not found",
};

export const EXIT_PORT_IN_USE = 98;
export const EXIT_NON_LOOPBACK = 99;

export class HostListenError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HostListenError";
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function sendOpaqueNotFound(response: ServerResponse): void {
  sendJson(response, 404, OPAQUE_NOT_FOUND);
}

export function sendProtocolRejected(
  response: ServerResponse,
  protocol: ProtocolRange = HOST_PROTOCOL,
): void {
  sendJson(response, 426, {
    status: "rejected",
    code: "protocol_unsupported",
    protocol: {
      min: protocol.min,
      max: protocol.max,
      features: [...protocol.features],
    },
  });
}

/** Redact path parameters after `/v1/sessions/` for Host logs. */
export function redactRoutePath(pathname: string): string {
  const parts = pathname.split("/");
  // ["", "v1", "sessions", "<id>", ...]
  if (parts[1] === "v1" && parts[2] === "sessions" && parts.length > 3) {
    return `/v1/sessions/:id${parts.length > 4 ? "/…" : ""}`;
  }
  return pathname;
}

export function readBearer(
  authorization: string | undefined,
): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(authorization.trim());
  return match?.[1];
}

export async function readJsonBody(
  request: import("node:http").IncomingMessage,
  limit = 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      const error = new Error("Request too large");
      (error as Error & { status: number }).status = 413;
      throw error;
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON");
    (error as Error & { status: number }).status = 400;
    throw error;
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

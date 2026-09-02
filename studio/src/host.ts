import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type StudioOptions = Readonly<{ agentServerUrl?: string; port?: number; open?: boolean }>;
export type StudioHost = Readonly<{ address: string; readonly agentServerUrl: string; setAgentServerUrl(url: string | undefined): void; open(): void; close(): Promise<void> }>;
export type StudioConfig = Readonly<{ agentServerUrl?: string }>;

const CONFIG_PATH = "/nylo-studio.config.json";
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
});

export function parseAgentServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("--agent-server-url must be an absolute http(s) URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--agent-server-url must use http or https.");
  if (url.username !== "" || url.password !== "") throw new Error("--agent-server-url must not contain credentials.");
  if (url.search !== "" || url.hash !== "") throw new Error("--agent-server-url must not contain a query string or fragment.");
  return url.href.replace(/\/$/u, "");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(`${JSON.stringify(value)}\n`);
}
function reject(response: ServerResponse, status: number, message: string): void { json(response, status, { error: { message } }); }
function browser(address: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", address] : [address];
  const child = spawn(command, args, { detached: true, stdio: "ignore" }); child.unref();
}
function staticPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (decoded.includes("\0")) return undefined;
  const candidate = resolve(root, decoded.replace(/^\/+/, "") || "index.html");
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : undefined;
}
function staticHeaders(file: string): Record<string, string> {
  const immutable = file.includes(`${sep}assets${sep}`);
  return {
    "content-type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    "x-content-type-options": "nosniff"
  };
}
async function sendFile(response: ServerResponse, method: string, file: string): Promise<boolean> {
  try {
    const content = await readFile(file);
    response.writeHead(200, staticHeaders(file));
    response.end(method === "HEAD" ? undefined : content);
    return true;
  } catch { return false; }
}

function loopbackHosts(port: number): ReadonlySet<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

type RequestHandle = (request: IncomingMessage, response: ServerResponse) => void;

async function listenOn(host: string, port: number, handle: RequestHandle): Promise<Server> {
  const server = createServer(handle);
  await new Promise<void>((ready, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      ready();
    });
  });
  return server;
}

function ipv6Optional(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPERM"].includes(String(error.code));
}

async function bindLoopback(handle: RequestHandle, port: number): Promise<Readonly<{ port: number; servers: readonly Server[] }>> {
  const ipv4 = await listenOn("127.0.0.1", port, handle);
  const address = ipv4.address();
  if (address === null || typeof address === "string") {
    ipv4.close();
    throw new Error("Studio did not report a TCP address.");
  }
  try {
    return Object.freeze({ port: address.port, servers: Object.freeze([ipv4, await listenOn("::1", address.port, handle)]) });
  } catch (error) {
    if (ipv6Optional(error)) return Object.freeze({ port: address.port, servers: Object.freeze([ipv4]) });
    ipv4.close();
    throw error;
  }
}

async function listenForStudio(handle: RequestHandle, port: number | undefined): Promise<Readonly<{ port: number; servers: readonly Server[] }>> {
  if (port !== undefined) return bindLoopback(handle, port);
  let lastError: unknown;
  for (let candidate = 4161; candidate <= 4260; candidate += 1) {
    try { return await bindLoopback(handle, candidate); }
    catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`No Studio port is available in the range 4161-4260.${lastError instanceof Error ? ` ${lastError.message}` : ""}`);
}

/** Serves the packaged React distribution and a non-secret in-memory runtime configuration. */
export async function startStudio(options: StudioOptions = {}): Promise<StudioHost> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");
  const requestedAgentServerUrl = options.agentServerUrl === undefined ? undefined : parseAgentServerUrl(options.agentServerUrl);
  let origin = "";
  let agentServerUrl = requestedAgentServerUrl;

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin || "http://localhost");
      if (origin === "" || !loopbackHosts(Number(new URL(origin).port)).has(request.headers.host ?? "")) {
        reject(response, 421, "Studio only accepts its own loopback Host header.");
        return;
      }
      if (url.pathname === "/_studio" || url.pathname.startsWith("/_studio/")) { reject(response, 404, "Studio has no API routes."); return; }
      if (url.pathname === CONFIG_PATH && request.method === "GET") { json(response, 200, agentServerUrl === undefined ? {} : { agentServerUrl }); return; }
      if (request.method !== "GET" && request.method !== "HEAD") { reject(response, 405, "Studio only serves static assets."); return; }
      const target = staticPath(root, url.pathname);
      if (target === undefined) { reject(response, 400, "Invalid Studio asset path."); return; }
      if (await sendFile(response, request.method, target)) return;
      if (extname(target) !== "") { reject(response, 404, "Studio asset not found."); return; }
      if (!(await sendFile(response, request.method, join(root, "index.html")))) reject(response, 500, "Studio distribution is missing. Reinstall or rebuild @nylorun/studio.");
    })();
  };

  const bound = await listenForStudio(handle, options.port);
  origin = `http://localhost:${bound.port}`;
  const address = origin;
  const host = Object.freeze({
    address,
    get agentServerUrl() { return agentServerUrl ?? ""; },
    setAgentServerUrl: (url: string | undefined) => { agentServerUrl = url === undefined ? undefined : parseAgentServerUrl(url); },
    open: () => browser(address),
    close: async () => {
      await Promise.all(bound.servers.map((server) => new Promise<void>((done, reject) => {
        server.closeAllConnections();
        server.close((error) => error === undefined ? done() : reject(error));
      })));
    }
  });
  if (options.open !== false) host.open();
  return host;
}

/** Alias retained for programmatic callers that used the static host name. */
export const startStaticStudio = startStudio;

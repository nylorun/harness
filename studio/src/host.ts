import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFileRecorder, type BuiltAgent } from "@nylorun/runtime";
import { startLocalRuntime } from "@nylorun/runtime/runtime-host";

export type StudioOptions = Readonly<{ project: string; agentServerUrl?: string; port?: number; open?: boolean }>;
export type StaticStudioOptions = Readonly<{ agentServerUrl?: string; port?: number; open?: boolean }>;
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
function localAgentPort(): number {
  const value = process.env.PORT;
  if (value === undefined) return 4111;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT ${value} is not a port number.`);
  return port;
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
export async function loadLocalAgent(project: string, cacheBust?: string): Promise<BuiltAgent> {
  const artifact = join(project, "dist", "agent.mjs");
  let module: { agent?: BuiltAgent };
  try { module = await import(`${pathToFileURL(artifact).href}${cacheBust === undefined ? "" : `?nylo=${encodeURIComponent(cacheBust)}`}`); }
  catch { throw new Error("dist/agent.mjs is missing or unreadable. Run `nylo build` before Studio."); }
  if (module.agent === undefined || typeof module.agent.session.start !== "function") throw new Error("dist/agent.mjs does not export an agent runtime handle. Rebuild the project.");
  const secrets = Object.entries(process.env).filter(([name, value]) => value !== undefined && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)).map(([, value]) => value!);
  return module.agent.withHost({ recorder: createFileRecorder({ projectRoot: project, redact: secrets }) });
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", ready); });
}

async function listenForStudio(server: Server, port: number | undefined): Promise<void> {
  if (port !== undefined) { await listen(server, port); return; }
  let lastError: unknown;
  for (let candidate = 4161; candidate <= 4260; candidate += 1) {
    try { await listen(server, candidate); return; }
    catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`No Studio port is available in the range 4161-4260.${lastError instanceof Error ? ` ${lastError.message}` : ""}`);
}

/** Serves the packaged React distribution and a non-secret in-memory runtime configuration. */
export async function startStaticStudio(options: StaticStudioOptions = {}): Promise<StudioHost> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");
  const requestedAgentServerUrl = options.agentServerUrl === undefined ? undefined : parseAgentServerUrl(options.agentServerUrl);
  let origin = "";
  let agentServerUrl = requestedAgentServerUrl;
  const server: Server = createServer((incoming, outgoing) => { void handle(incoming, outgoing); });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", origin || "http://nylo.run.localhost");
    if (origin === "" || request.headers.host !== new URL(origin).host) { reject(response, 421, "Studio only accepts its own loopback Host header."); return; }
    if (url.pathname === "/_studio" || url.pathname.startsWith("/_studio/")) { reject(response, 404, "Studio has no API routes."); return; }
    if (url.pathname === CONFIG_PATH && request.method === "GET") { json(response, 200, agentServerUrl === undefined ? {} : { agentServerUrl }); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { reject(response, 405, "Studio only serves static assets."); return; }
    const target = staticPath(root, url.pathname);
    if (target === undefined) { reject(response, 400, "Invalid Studio asset path."); return; }
    if (await sendFile(response, request.method, target)) return;
    if (extname(target) !== "") { reject(response, 404, "Studio asset not found."); return; }
    if (!(await sendFile(response, request.method, join(root, "index.html")))) reject(response, 500, "Studio distribution is missing. Reinstall or rebuild @nylorun/studio.");
  };

  await listenForStudio(server, options.port);
  const bound = server.address();
  if (bound === null || typeof bound === "string") { server.close(); throw new Error("Studio did not report a TCP address."); }
  origin = `http://nylo.run.localhost:${bound.port}`;
  const address = origin;
  return Object.freeze({
    address,
    get agentServerUrl() { return agentServerUrl ?? ""; },
    setAgentServerUrl: (url) => { agentServerUrl = url === undefined ? undefined : parseAgentServerUrl(url); },
    open: () => browser(address),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => error === undefined ? done() : reject(error)));
    }
  });
}

/** Backwards-compatible convenience launcher for a static Studio plus a local built agent. */
export async function startStudio(options: StudioOptions): Promise<StudioHost> {
  const studio = await startStaticStudio({ agentServerUrl: options.agentServerUrl, port: options.port, open: false });
  if (options.agentServerUrl === undefined) {
    try {
      const local = await loadLocalAgent(resolve(options.project));
      const runtime = await startLocalRuntime(local, { port: localAgentPort(), cors: { allowedOrigins: [studio.address] } });
      studio.setAgentServerUrl(runtime.address);
      const paired = Object.freeze({
        address: studio.address,
        get agentServerUrl() { return studio.agentServerUrl; },
        setAgentServerUrl: studio.setAgentServerUrl,
        open: studio.open,
        close: async () => { await studio.close(); await runtime.close(); }
      });
      if (options.open !== false) paired.open();
      return paired;
    } catch (error) {
      await studio.close();
      throw error;
    }
  }
  if (options.open !== false) studio.open();
  return studio;
}

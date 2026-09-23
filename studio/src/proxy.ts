import type { IncomingMessage, ServerResponse } from "node:http";
/** Local tooling proxy: credentials stay in this process, not the browser. */
export async function proxyRuntime(
  request: IncomingMessage,
  response: ServerResponse,
  options: { origin: string; runtimeUrl: string; serverKey: string },
): Promise<void> {
  const incoming = new URL(request.url!, options.origin);
  const path = incoming.pathname.slice("/_studio/runtime".length);
  const method = request.method ?? "GET";
  const fail = (status: number, message: string) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ message }));
  };
  const read =
    method === "GET" &&
    (/^\/v1\/(agents|sessions)$/.test(path) ||
      /^\/v1\/sessions\/[^/]+(?:\/(items|events))?$/.test(path) ||
      path === "/v1/host/model" ||
      path === "/v1/host/models");
  const write =
    (method === "PUT" && /^\/v1\/sessions\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/v1\/sessions\/[^/]+\/commands$/.test(path));
  const hostWrite = method === "PUT" && path === "/v1/host/model";
  if (!read && !write && !hostWrite)
    return fail(404, "Unsupported Studio operation");
  if ((write || hostWrite) && request.headers.origin !== options.origin)
    return fail(403, "Studio mutations require a same-origin request");
  let body: string | undefined;
  if (write || hostWrite) {
    if (!request.headers["content-type"]?.startsWith("application/json"))
      return fail(415, "JSON required");
    let text = "";
    for await (const chunk of request) {
      text += chunk;
      if (Buffer.byteLength(text) > 1024 * 1024)
        return fail(413, "Request too large");
    }
    let value: any;
    try {
      value = JSON.parse(text);
    } catch {
      return fail(400, "Invalid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail(400, "JSON object required");
    if (!hostWrite && method === "PUT") value.ownerUserId = "local-developer";
    else if (!hostWrite && !["message", "cancel"].includes(value.type))
      return fail(
        400,
        "This Studio release supports message and cancel commands",
      );
    body = JSON.stringify(value);
  }
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  try {
    const upstream = await fetch(options.runtimeUrl + path + incoming.search, {
      method,
      body,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${options.serverKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(request.headers["last-event-id"]
          ? { "last-event-id": String(request.headers["last-event-id"]) }
          : {}),
        accept: request.headers.accept ?? "application/json",
      },
    });
    response.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    if (upstream.body)
      for await (const chunk of upstream.body) {
        if (!response.write(chunk))
          await new Promise<void>((resolve) => {
            const done = () => {
              response.off("drain", done);
              response.off("close", done);
              resolve();
            };
            response.once("drain", done);
            response.once("close", done);
          });
        if (controller.signal.aborted) break;
      }
    response.end();
  } catch {
    if (!response.headersSent) fail(502, "Local Runtime is unavailable");
    else response.end();
  }
}

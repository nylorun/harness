/**
 * The small runtime surface embedded into a published agent artifact.  Keeping
 * it separate from the authoring/CLI barrel prevents a deployable bundle from
 * pulling build-time Vite code into its dependency graph.
 */
import { createServer, type Server } from "node:http";
import { Fetchable, type CorsOptions } from "./fetchable.js";
import type { BuiltAgent } from "./bind.js";

export { __nyloBindAgent } from "./bind.js";
export { Fetchable } from "./fetchable.js";

/** A loopback-only development host. It intentionally adds no authentication or browser surface. */
export type LocalRuntimeHost = Readonly<{
  address: string;
  agent: string;
  close(): Promise<void>;
}>;

export async function startLocalRuntime(agent: BuiltAgent, options: Readonly<{ port?: number; cors?: CorsOptions }> = {}): Promise<LocalRuntimeHost> {
  const port = options.port ?? 0;
  const handler = Fetchable(agent, { ...(options.cors === undefined ? {} : { cors: options.cors }) });
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.once("end", () => {
      const method = incoming.method ?? "GET";
      const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
        method,
        headers: incoming.headers as Record<string, string>,
        ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) })
      });
      void handler(request).then(async (response) => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body !== null) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) outgoing.write(chunk);
        outgoing.end();
      }).catch(() => { outgoing.statusCode = 500; outgoing.end(); });
    });
  });
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => ready()); });
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("The local runtime did not report a TCP address.");
  return Object.freeze({
    address: `http://127.0.0.1:${bound.port}`,
    agent: agent.config.name,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => error === undefined ? done() : reject(error)));
      await agent.close();
    }
  });
}

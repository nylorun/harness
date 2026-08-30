import { serve } from "@hono/node-server";
import { createServer } from "vite";

const port = Number(process.env.PORT ?? "4111");
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
let current = await load();
const retained = [current];
const server = serve({
  port,
  hostname: "127.0.0.1",
  fetch: (request) => runtimeFor(request).app.fetch(request),
});
process.stdout.write(`Vite HMR Agent Server on http://127.0.0.1:${port}\n`);

vite.watcher.on("change", async (file) => {
  if (!/\/(agents|capabilities|services|skills|server)\//u.test(file)) return;
  try {
    const replacement = await load();
    current = replacement;
    retained.push(replacement);
    process.stdout.write(`Reloaded agent definitions after ${file}\n`);
  } catch (error) {
    process.stderr.write(
      `Reload failed; existing agents remain active: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
});

function runtimeFor(request) {
  const match = new URL(request.url).pathname.match(
    /^\/agents\/([^/]+)\/v1\/(?:sessions|ag-ui\/sessions)\/([^/]+)/u,
  );
  return match === null
    ? current
    : ([...retained].reverse().find((runtime) => runtime.hasSession(match[1], match[2])) ??
        current);
}

async function load() {
  const module = await vite.ssrLoadModule("/server/server.ts");
  return module.createAgentServer({ root: process.cwd() });
}

async function stop() {
  server.close();
  await vite.close();
  await Promise.all(retained.map((runtime) => runtime.close()));
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

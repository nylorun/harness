import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadProjectEnvironment } from "./environment.js";

export async function start(
  entry = "dist/src/index.js",
  development = false
): Promise<void> {
  loadProjectEnvironment();
  if (development) process.env.NYLORUN_DEV = "1";
  else delete process.env.NYLORUN_DEV;
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535.");
  const { default: app } = await import(pathToFileURL(resolve(entry)).href);
  if (!app || typeof app.fetch !== "function")
    throw new Error(
      `${entry} must export a Hono application with 'export default app' and a callable fetch.`
    );
  const server = serve({ fetch: app.fetch.bind(app), port }, (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  });
  const stop = () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

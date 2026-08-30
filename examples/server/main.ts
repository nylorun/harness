import { serve } from "@hono/node-server";
import { createAgentServer } from "./server.js";
import { loadDotEnv } from "../services/pi.js";

loadDotEnv();
const port = Number(process.env.PORT ?? "4111");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

const runtime = await createAgentServer();
const server = serve({ fetch: runtime.app.fetch, port, hostname: "127.0.0.1" });
server.on("error", (error) => {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  process.stderr.write(
    code === "EADDRINUSE"
      ? `Port ${port} is already in use. Stop the other agent server or set PORT.\n`
      : `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
  void runtime.close();
});
process.stdout.write(`Agent server on http://127.0.0.1:${port}\n`);
const stop = () => {
  server.close();
  void runtime.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

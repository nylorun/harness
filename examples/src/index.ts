import { Hono } from "hono";
import { Runtime, serveAgents } from "@nylorun/runtime";
import { localSessions } from "@nylorun/runtime/node";
import { agents, media } from "../agents/index.js";

const runtime = new Runtime({ media, sessions: localSessions({ root: ".data/sessions" }) });
const app = new Hono();

app.get("/", (c) =>
  c.json({
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      manifest: agent.manifest,
    })),
  }),
);
app.route(
  "/agents",
  serveAgents({ agents, runtime })
);

// Application resources have their own lifecycle; drain execution before closing them.
let closing: Promise<void> | undefined;
const close = () => closing ??= runtime.close().then(async () => {
  await Promise.all(agents.map(agent => agent.close?.()));
});
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });

export default app;

import { Hono } from "hono";
import { Runtime, serveAgents } from "@nylorun/runtime";
import { agents, media } from "../agents/index.js";

const runtime = new Runtime({ media });
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

export default app;

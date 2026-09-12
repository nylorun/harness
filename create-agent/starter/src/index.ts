import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Runtime, serveAgents } from "@nylorun/runtime";
import { agents } from "../agents/index.js";

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

const runtime = new Runtime();
app.route(
  "/agents",
  serveAgents({ agents, runtime })
);

serve(
  {
    fetch: app.fetch,
    port: Number(process.env.PORT ?? "3000"),
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);

import { serve } from "@hono/node-server";
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
  serveAgents({ agents, runtime, basePath: "/agents" }),
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

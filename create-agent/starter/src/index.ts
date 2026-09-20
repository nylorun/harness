import { Hono } from "hono";
import { Runtime, serveAgents } from "@nylorun/runtime";
import { agents } from "../agents/index.js";

/**
 * One Runtime for this process. Studio AG-UI (mounted below) and
 * `openSession(agent)` share it. Local by default; Cloud when
 * `NYLORUN_URL` + `NYLORUN_SECRET_KEY` resolve (or `NYLORUN_MODE=cloud`).
 * Force local with `NYLORUN_MODE=local`. Runtime owns the model via
 * `onModelCall` / env — do not put `model` on `Agent({})`.
 */
const runtime = new Runtime();

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

// Studio + `nylorun dev` expect the agent host under `/agents`.
// Passing `runtime` keeps the 1.0 Hono overload. Without `runtime`,
// `serveAgents({ agents })` returns `{ fetch }` for Workers / route handlers.
app.route("/agents", serveAgents({ agents, runtime }));

export default app;

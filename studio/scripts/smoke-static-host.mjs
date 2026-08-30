import { startStudio } from "../dist/host.js";

const studio = await startStudio({ project: process.cwd(), agentServerUrl: "https://agent.example.internal", port: 0, open: false });
try {
  const [config, route, legacy] = await Promise.all([
    fetch(`${studio.address}/nylo-studio.config.json`),
    fetch(`${studio.address}/a/client/route`),
    fetch(`${studio.address}/_studio/health`)
  ]);
  if (config.status !== 200 || (await config.json()).agentServerUrl !== "https://agent.example.internal") throw new Error("Studio did not serve its Agent Server configuration.");
  if (route.status !== 200 || !((await route.text()).includes("Nylo Studio"))) throw new Error("Studio did not serve its SPA fallback.");
  if (legacy.status !== 404) throw new Error("Studio must not expose legacy proxy routes.");
  console.log("Studio static-host smoke test passed.");
} finally {
  await studio.close();
}

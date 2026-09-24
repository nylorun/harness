import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const [repo, runtimePort, studioPort, open, project] = process.argv.slice(2);
const { startStudio } = await import(
  pathToFileURL(join(repo, "studio/dist/index.js")).href
);
const credentials = JSON.parse(
  await readFile(join(project, ".nylorun/credentials.json"), "utf8"),
);
const link = JSON.parse(
  await readFile(join(project, ".nylorun/link.json"), "utf8"),
);
const studio = await startStudio({
  runtimeUrl: `http://127.0.0.1:${runtimePort}`,
  serverKey: credentials.applicationKey,
  tenant: { id: link.tenantId, name: link.tenantId },
  port: Number(studioPort),
  open: open === "true",
});
console.log(`Studio on ${studio.address}`);
process.once("SIGINT", () => void studio.close());
process.once("SIGTERM", () => void studio.close());

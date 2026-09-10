import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { availablePort } from "./lib/development.mjs";

const [repo, runtimePort, studioPort, open] = process.argv.slice(2);
const require = createRequire(join(repo, "studio/package.json"));
const { createServer } = await import(
  pathToFileURL(require.resolve("vite")).href
);
const { startStudio } = await import(
  pathToFileURL(join(repo, "studio/dist/index.js")).href
);
let backend, frontend;
async function close() {
  await frontend?.close();
  await backend?.close();
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
try {
  backend = await startStudio({
    agentServerUrl: `http://127.0.0.1:${runtimePort}`,
    port: await availablePort(),
    open: false,
  });
  frontend = await createServer({
    configFile: join(repo, "studio/vite.config.ts"),
    root: join(repo, "studio/web"),
    server: {
      host: "127.0.0.1",
      port: Number(studioPort),
      strictPort: true,
      open: open === "true",
      proxy: {
        "/nylo-studio.config.json": {
          target: backend.address,
          changeOrigin: true,
        },
      },
    },
  });
  await frontend.listen();
  frontend.printUrls();
} catch (error) {
  console.error(error.message);
  await close();
  process.exitCode = 1;
}

import { defineConfig } from "vite";

/** Vite builds the Node Hono host and provides the dev module graph used by scripts/dev.mjs. */
export default defineConfig({
  build: {
    target: "node22",
    ssr: true,
    rollupOptions: {
      external: [
        "@nylorun/harness",
        "@modelcontextprotocol/sdk",
        "dotenv",
        "hono",
        "@hono/node-server",
      ],
    },
  },
});

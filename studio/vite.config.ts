import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss(), {
    name: "exclude-harness-engine",
    moduleParsed(info) {
      if (/harness[/\\](?:dist|src)[/\\](?:engine|execution)[/\\]/.test(info.id)) {
        this.error("Studio must not bundle harness engine modules: " + info.id);
      }
    },
  }],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) }
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: false
  }
});

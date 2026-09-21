import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss(), {
    name: "exclude-harness-run",
    moduleParsed(info) {
      if (/[/\\](?:harness|runtime|cli)[/\\](?:dist|src)[/\\]/.test(info.id) || /agents[/\\](?:dist|src)[/\\](?:executor|execute-action)\./.test(info.id)) {
        this.error("Studio must not bundle harness execution modules: " + info.id);
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

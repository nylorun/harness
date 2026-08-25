import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) }
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: false
  },
  test: {
    environment: "jsdom",
    include: ["../test/**/*.test.ts", "src/**/*.test.ts?(x)"]
  }
});

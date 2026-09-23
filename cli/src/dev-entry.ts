import { runProject } from "./project-runner.js";
await runProject("agents/index.ts", {
  studio: !process.argv.includes("--no-studio"),
  open: !process.argv.includes("--no-open"),
  autostart: !process.argv.includes("--no-autostart"),
});

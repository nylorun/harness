import { start } from "./launcher.js";

await start(process.argv[2] ?? "src/index.ts", true);

import { execFileSync } from "node:child_process";

const output = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc", "--version"], { encoding: "utf8" });
if (!/^Version 7\./u.test(output)) throw new Error(`Studio requires TypeScript 7; received ${output.trim()}.`);

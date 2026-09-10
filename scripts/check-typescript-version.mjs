import { execFileSync } from "node:child_process";
import { npmCli } from "./lib/repo.mjs";

// Every workspace compiles with the TypeScript 7 native compiler; `typescript`
// itself is aliased to the TypeScript 6 bridge for scripts that use the API.
const output = execFileSync(
  process.execPath,
  [npmCli(), "exec", "--", "tsc", "--version"],
  { encoding: "utf8" },
);
if (!/^Version 7\./u.test(output))
  throw new Error(
    `This workspace requires TypeScript 7 (run npm run setup); received ${output.trim()}.`,
  );

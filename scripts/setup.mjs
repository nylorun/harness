import { join } from "node:path";
import { root, npm, node, verifyToolchain } from "./lib/repo.mjs";

try {
  await verifyToolchain();
  await npm(["ci"]);
  await node("scripts/validate.mjs", ["build"]);
  await npm(["ci"], { cwd: join(root, "examples") });
  console.log(
    "Ready. Run npm run dev; run npm run configure before your first conversation.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

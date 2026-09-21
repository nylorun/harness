import { checkBoundaries } from "../../scripts/check-boundaries.mjs";
checkBoundaries("core");
const definition = await import("@nylorun/core/define");
const root = await import("@nylorun/core");
if ("Agent" in root || "run" in root)
  throw new Error("Core root only exposes contracts and types");
const agent = definition
  .Agent({ id: "package-check", name: "Package check" })
  .build();
if (Object.keys(agent).includes("getBinding"))
  throw new Error("Binding must not serialize");
if (agent.getBinding().manifest !== agent.manifest)
  throw new Error("Binding identity differs");

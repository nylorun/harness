import { registerHooks } from "node:module";
const loaded = [];
const hooks = registerHooks({
  load(url, context, next) {
    loaded.push(url);
    return next(url, context);
  },
});
try {
  const { checkBoundaries } = await import(
    "../../scripts/check-boundaries.mjs"
  );
  checkBoundaries("agents");
  const sdk = await import("@nylorun/agents");
  for (const name of ["Agent", "createClient", "connectAgents"])
    if (typeof sdk[name] !== "function")
      throw new Error(`Missing SDK export ${name}`);
  const execution = loaded.filter((url) =>
    /[/\\](?:harness|runtime|cli)[/\\](?:src|dist)[/\\]/.test(url)
  );
  if (execution.length)
    throw new Error(`SDK loaded execution modules: ${execution.join(", ")}`);
  console.log("SDK entry point imports; no engine or host modules loaded.");
} finally {
  hooks.deregister();
}

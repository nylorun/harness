import { registerHooks } from "node:module";
const loaded = [];
const hooks = registerHooks({
  load(url, context, next) {
    loaded.push(url);
    return next(url, context);
  },
});
try {
  const sdk = await import("@nylorun/agents");
  for (const name of ["Agent", "createClient", "connectAgents"])
    if (typeof sdk[name] !== "function")
      throw new Error(`Missing SDK export ${name}`);
  const engine = loaded.filter((url) =>
    /harness\/(?:src|dist)\/(engine|execution)\//.test(url)
  );
  if (engine.length)
    throw new Error(`SDK loaded engine modules: ${engine.join(", ")}`);
  console.log("SDK entry point imports; no engine/execution modules loaded.");
} finally {
  hooks.deregister();
}

import { envelope, importAgent } from "./index.js";
import type { Args } from "./args.js";

/** Reports the actual capability manifest produced by the configured Harness factory. */
export async function runAdapterProbe(args: Args): Promise<number> {
  if (args.positionals[0] !== "probe") {
    process.stderr.write("error nylo adapter requires `probe`.\n");
    return 2;
  }
  const ready = await (await importAgent(args)).ready();
  const data = { state: "matches", harness: ready.harness, model: ready.model, diagnostics: ready.diagnostics };
  if (args.json) process.stdout.write(envelope("adapter probe", true, data));
    else process.stdout.write(`adapter @nylorun/harness: matches (${ready.harness.middleware.length} middleware)\n`);
  return 0;
}

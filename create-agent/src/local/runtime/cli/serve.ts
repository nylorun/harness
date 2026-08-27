import { startLocalRuntime } from "../runtime/host.js";
import { styleFor } from "../runtime/render.js";
import type { Args } from "./args.js";
import { importAgent } from "./index.js";

/**
 * `Fetchable(agent)` behind `node:http` and nothing more, so this command and a builder's own server
 * exercise identical code. Nylo supplies no authentication here and does not pretend to.
 */
export async function runServe(args: Args): Promise<number> {
  const agent = await importAgent(args);
  const style = styleFor(process.stdout.isTTY === true && !args.json);
  const runtime = await startLocalRuntime(agent, { port: args.port });
  const address = runtime.address;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ command: "serve", ok: true, data: { address, agent: agent.config.name } })}\n`);
  } else {
    process.stdout.write(
      `${style.bold(`${agent.config.name} on ${address}`)}\n` +
        `${style.dim("bound to loopback, and nothing is guarding it — put your own server in front before anything else can reach it")}\n`
    );
  }
  await new Promise<void>((stop) => process.on("SIGINT", () => stop()));
  await runtime.close();
  return 0;
}

import { run, bindingFromAgent } from "../src/engine/index.js";
import type { BuiltAgent } from "../src/types/agent.js";
import type { AgentBuilder } from "../src/definition/builder.js";
import type { RunOptions } from "../src/types/execution.js";
/** Test-only spelling migration. Production definitions have no executable facade. */
export function runAgent(
  agent: BuiltAgent<any, any> | AgentBuilder<any, any>,
  options: RunOptions<any>,
) {
  return run({ binding: bindingFromAgent("build" in agent ? agent.build() : agent), ...options });
}

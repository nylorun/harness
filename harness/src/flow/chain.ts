import type { JsonValue } from "@nylorun/core/define";
import type { WorkflowChainNode } from "@nylorun/core";
import type { FlowContext } from "./context.js";
import { joinPath } from "./paths.js";
import { runNode, unwrapSlot } from "./node.js";

/**
 * Chain: steps in order; step 1 gets chain input; later steps get prior output
 * unless a slot `input` reshapes. `results` is lexical for the nearest enclosing Chain.
 */
export async function runChain(
  ctx: FlowContext,
  chain: WorkflowChainNode["chain"],
  path: string,
  input: JsonValue,
): Promise<JsonValue> {
  const results: Record<string, JsonValue> = {};
  const chainInput = input;
  ctx.resultsStack.push(results);
  try {
    let current = input;
    for (const step of chain.steps) {
      const { part } = unwrapSlot(step);
      const stepPath = joinPath(path, part);
      const output = await runNode(ctx, step, stepPath, current, {
        ownerInput: chainInput,
      });
      results[part] = output;
      current = output;
    }
    return current;
  } finally {
    ctx.resultsStack.pop();
  }
}

import type { JsonValue } from "@nylorun/core/define";
import type { WorkflowSwitchNode } from "@nylorun/core";
import type { FlowContext } from "./context.js";
import { FlowNodeError } from "./types.js";
import { joinPath, nodeKeyOf } from "./paths.js";
import { runNode } from "./node.js";

/**
 * Switch: `fn` effect for `on`, select case or fail `switch.no-match`, run chosen case.
 * The key is journaled so replay always takes the same case.
 */
export async function runSwitch(
  ctx: FlowContext,
  node: WorkflowSwitchNode["switch"],
  path: string,
  input: JsonValue,
): Promise<JsonValue> {
  const key = await ctx.effect(
    "fn",
    input,
    { path, key: `${nodeKeyOf(path)}/on` },
    { role: "switch-on" },
  );

  if (typeof key !== "string") {
    throw new FlowNodeError({
      code: "fn.failed",
      message: `Switch.on must return a string, got ${typeof key}`,
      path,
    });
  }

  let caseNode = node.cases[key];
  let casePart = key;
  if (!caseNode) {
    if (node.default) {
      caseNode = node.default;
      casePart = "default";
    } else {
      throw new FlowNodeError({
        code: "switch.no-match",
        message: `No Switch case matched key ${JSON.stringify(key)}`,
        path,
      });
    }
  }

  // Selection is implied by the journaled `on` result; Runtime emits switch.selected.
  const casePath = joinPath(path, casePart);
  return runNode(ctx, caseNode, casePath, input);
}

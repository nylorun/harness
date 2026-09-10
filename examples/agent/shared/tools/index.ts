import { projectAsset } from "@nylorun/runtime";
import { join } from "node:path";
import type { CapabilityDeclaration } from "@nylorun/harness";
import { loadToolsFromDirectory } from "./load.js";

export const TOOLS_CATALOG = projectAsset("agent/shared/tools/catalog");

export type ToolsSource = { readonly directory: string };

export async function tools(
  source: ToolsSource = { directory: TOOLS_CATALOG },
): Promise<CapabilityDeclaration> {
  const loaded = await loadToolsFromDirectory(source.directory);
  if (loaded.length === 0) return { id: "tools" };
  return { id: "tools", tools: loaded };
}

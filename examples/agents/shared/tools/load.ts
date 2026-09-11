import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition } from "@nylorun/harness";

export async function loadToolsFromDirectory(
  root: string
): Promise<readonly ToolDefinition[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const loaded: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".d.ts")
    )
      continue;
    if (entry.name.startsWith(".") || entry.name.endsWith(".test.ts")) continue;
    const module = await import(pathToFileURL(join(root, entry.name)).href);
    for (const tool of toolsFromModule(module)) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      loaded.push(tool);
    }
  }
  return loaded;
}

function toolsFromModule(module: unknown): readonly ToolDefinition[] {
  if (module === null || typeof module !== "object") return [];
  const record = module as {
    tools?: unknown;
    tool?: unknown;
    default?: unknown;
  };
  if (Array.isArray(record.tools) && record.tools.every(isToolDefinition))
    return record.tools;
  if (isToolDefinition(record.tool)) return [record.tool];
  if (record.default !== undefined && record.default !== module)
    return toolsFromModule(record.default);
  return [];
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string" &&
    "inputSchema" in value &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

import { join } from "node:path";
import { imageEditorConfig, providerConfig } from "./env.js";
import { createOpenAICompatibleAdapter } from "../services/openai-compatible.js";
import { createCodeMode } from "../agents/code-mode.js";
import { createCodingAgent } from "../agents/coding-agent.js";
import { createGuardrails } from "../agents/guardrails.js";
import { createInteractions } from "../agents/interactions.js";
import { createMcpAgent } from "../agents/mcp.js";
import { createSandbox } from "../agents/sandbox.js";
import { createInstructions } from "../agents/instructions.js";
import { createInteriorDesign } from "../agents/interior-design.js";
import { createSkills } from "../agents/skills.js";
import { createSubagents } from "../agents/subagents.js";
import { createToolUse } from "../agents/tool-use.js";
import type { ExampleAgent } from "../agents/types.js";
import type { ModelAdapter } from "@nylorun/harness";
import { MediaStore } from "../services/media.js";
import type { ImageEditor } from "../services/openai-image.js";

export async function createRegistry(
  root: string,
  override:
    | Readonly<{ adapter: ModelAdapter; provider: string; model: string }>
    | undefined = undefined,
  services: Readonly<{ media?: MediaStore; imageEditor?: ImageEditor }> = {},
): Promise<readonly ExampleAgent[]> {
  const configured = override === undefined ? providerConfig() : undefined;
  const { provider, model } = override ?? configured!;
  const media = services.media ?? new MediaStore(join(root, ".data", "media"));
  const deps = {
    adapter:
      override?.adapter ??
      createOpenAICompatibleAdapter({
        baseUrl: configured!.baseUrl,
        apiKey: configured!.apiKey,
        model,
        headers: configured!.headers,
        media,
      }),
    provider,
    model,
    dataRoot: join(root, ".data"),
    media,
    imageEditor: services.imageEditor ?? imageEditorConfig(),
  };
  return Object.freeze([
    createInstructions(deps),
    createInteriorDesign(deps),
    await createSkills(deps),
    await createToolUse(deps),
    await createGuardrails(deps),
    createInteractions(deps),
    createMcpAgent(deps),
    createSandbox(deps),
    await createCodeMode(deps),
    await createSubagents(deps),
    createCodingAgent(deps),
  ]);
}

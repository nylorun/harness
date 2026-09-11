import { join } from "node:path";
import { localMedia, type MediaStore } from "@nylorun/runtime";
import { createCodeMode } from "./code-mode/agent.js";
import { createCodingAgent } from "./coding-agent/agent.js";
import { createGuardrails } from "./guardrails/agent.js";
import { createInteractions } from "./interactions/agent.js";
import { createMcpAgent } from "./mcp/agent.js";
import { createSandbox } from "./sandbox/agent.js";
import { createInstructions } from "./instructions/agent.js";
import { createInteriorDesign } from "./interior-design/agent.js";
import { createSkills } from "./skills/agent.js";
import { createSubagents } from "./subagents/agent.js";
import { createToolUse } from "./tool-use/agent.js";
import {
  createOpenAIImageEditor,
  type ImageEditor,
} from "./interior-design/image-editor.js";
import type { ExampleAgent } from "./shared/types.js";

export async function createRegistry(
  root: string,
  override?: Readonly<{ provider: string; model: string }>,
  services: Readonly<{ media?: MediaStore; imageEditor?: ImageEditor }> = {},
): Promise<readonly ExampleAgent[]> {
  const media =
    services.media ?? localMedia({ root: join(root, ".data", "media") });
  const deps = {
    provider: override?.provider ?? "configured",
    model: override?.model ?? "configured-model",
    dataRoot: join(root, ".data"),
    media,
    imageEditor:
      services.imageEditor ??
      (process.env.OPENAI_API_KEY
        ? createOpenAIImageEditor({
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2",
          })
        : undefined),
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
export const media = localMedia();
export const agents = await createRegistry(process.cwd(), undefined, { media });

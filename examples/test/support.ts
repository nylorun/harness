import { join } from "node:path";
import type { ModelAdapter } from "@nylorun/harness";
import {
  createRuntime,
  defineRuntime,
  localJsonl,
  localMedia,
} from "@nylorun/runtime";
import { createRegistry } from "../agent/registry.js";
import type { ImageEditor } from "../agent/interior-design/image-editor.js";

export async function createAgentServer(
  options: {
    root?: string;
    adapter?: ModelAdapter;
    provider?: string;
    model?: string;
    imageEditor?: ImageEditor;
  } = {},
) {
  const root = options.root ?? process.cwd();
  const media = localMedia({ root: join(root, ".data", "media") });
  const agents = await createRegistry(
    root,
    options.adapter
      ? {
          adapter: options.adapter,
          provider: options.provider ?? "test",
          model: options.model ?? "test-model",
        }
      : undefined,
    { media, imageEditor: options.imageEditor },
  );
  return createRuntime(
    defineRuntime({
      agents,
      media,
      persistence: localJsonl({ root: join(root, ".data", "sessions") }),
    }),
  );
}

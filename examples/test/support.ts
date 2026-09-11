import { join } from "node:path";
import type { ModelAdapter } from "@nylorun/harness";
import {
  Runtime,
  localJsonl,
  localMedia,
  serveAgents,
} from "@nylorun/runtime";
import { createRegistry } from "../agents/index.js";
import type { ImageEditor } from "../agents/interior-design/image-editor.js";

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
          provider: options.provider ?? "test",
          model: options.model ?? "test-model",
        }
      : undefined,
    { media, imageEditor: options.imageEditor },
  );
  const runtime = new Runtime({
    media,
    observer: () => {},
    ...(options.adapter === undefined ? {} : { onModelCall: options.adapter }),
    durability: localJsonl({ root: join(root, ".data", "sessions") }),
  });
  return Object.freeze({
    app: serveAgents({ agents, runtime }),
    close: () => runtime.close(),
  });
}

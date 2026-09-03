import { tool } from "@nylorun/harness";
import { z } from "zod";
import type { MediaStore } from "../services/media.js";
import type { ImageEditor } from "../services/openai-image.js";

export function interiorDesign(
  store: MediaStore,
  editor: ImageEditor | undefined,
) {
  return {
    id: "interior-design",
    instructions: [
      "Use reimagine_interior only after the user supplies a room photo and a requested design theme.",
      "Preserve the room layout, viewpoint, windows, doors, and architectural constraints; change furnishings, materials, lighting, and decor to fit the requested theme.",
      "If the user supplied a photo without a theme, ask one concise question for their preferred theme before calling the tool.",
    ],
    tools: [
      tool({
        name: "reimagine_interior",
        description:
          "Create a redesigned image of the most recently uploaded room photo for a requested interior design theme.",
        inputSchema: z.object({ theme: z.string().min(3).max(300) }),
        async execute({ theme }, context) {
          if (!editor)
            return {
              kind: "failed" as const,
              code: "image.not-configured",
              message:
                "Set OPENAI_API_KEY to enable the Interior Design image editor.",
            };
          const source = await store.latestInput(
            "interior-design",
            context.sessionId,
          );
          if (!source)
            return {
              kind: "failed" as const,
              code: "image.missing-input",
              message: "Upload one room photo before requesting a redesign.",
            };
          const input = await store.read(
            "interior-design",
            context.sessionId,
            source.id,
          );
          if (!input)
            return {
              kind: "failed" as const,
              code: "image.missing-input",
              message: "The uploaded room photo is no longer available.",
            };
          try {
            const result = await editor.edit({
              bytes: input.bytes,
              mediaType: input.asset.mediaType,
              prompt: `Reimagine this exact interior in a ${theme} theme. Preserve the room's layout, camera viewpoint, architecture, windows, doors, and proportions. Change only furnishings, finishes, lighting, and decor. Produce a realistic interior design visualization.`,
              signal: context.signal,
            });
            const image = await store.saveGenerated(
              "interior-design",
              context.sessionId,
              result.mediaType,
              result.bytes,
            );
            return {
              kind: "completed" as const,
              output: {
                image: {
                  id: image.id,
                  mediaType: image.mediaType,
                  bytes: image.bytes,
                  kind: image.kind,
                },
                theme,
              },
            };
          } catch (error) {
            return {
              kind: "failed" as const,
              code: "image.edit-failed",
              message:
                error instanceof Error ? error.message : "Image edit failed.",
            };
          }
        },
      }),
    ],
  } as const;
}

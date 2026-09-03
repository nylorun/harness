import { describe, expect, it } from "vitest";
import type { ObserveModelRequested } from "@nylorun/harness";
import { modelRequestDigests } from "../server/digests.js";

const attributes: ObserveModelRequested = {
  call: {
    sessionId: "session",
    prompt: [
      {
        kind: "message",
        role: "user",
        content: [
          { type: "text", text: "Describe this room." },
          {
            type: "media",
            mediaType: "image/png",
            reference: { agentId: "interior-design", assetId: "asset-a" },
          },
        ],
      },
    ],
    tools: [{ name: "redesign", inputSchema: { type: "object" } }],
    outputSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
    },
  },
  configuration: {
    version: 1,
    instructions: [],
    tools: [],
    toolContracts: [
      {
        name: "redesign",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { image: { type: "string" } },
        },
        contributor: { middlewareId: "interior", slot: "tools", order: 0 },
      },
    ],
    contributors: [],
  },
  context: { items: [], contributors: [] },
};

describe("model request digests", () => {
  it("changes for every model-visible or execution-contract dimension", () => {
    const baseline = modelRequestDigests(attributes);
    const text = modelRequestDigests({
      ...attributes,
      call: {
        ...attributes.call,
        prompt: [
          {
            ...attributes.call.prompt[0]!,
            content: [{ type: "text", text: "Use warmer lighting." }],
          },
        ],
      },
    });
    const media = modelRequestDigests({
      ...attributes,
      call: {
        ...attributes.call,
        prompt: [
          {
            ...attributes.call.prompt[0]!,
            content: [
              { type: "text", text: "Describe this room." },
              {
                type: "media",
                mediaType: "image/png",
                reference: { agentId: "interior-design", assetId: "asset-b" },
              },
            ],
          },
        ],
      },
    });
    const toolOutput = modelRequestDigests({
      ...attributes,
      configuration: {
        ...attributes.configuration,
        toolContracts: [
          {
            ...attributes.configuration.toolContracts[0]!,
            outputSchema: {
              type: "object",
              properties: { image: { type: "number" } },
            },
          },
        ],
      },
    });
    const output = modelRequestDigests({
      ...attributes,
      call: { ...attributes.call, outputSchema: { type: "array" } },
    });
    const model = modelRequestDigests({
      ...attributes,
      call: { ...attributes.call, model: { id: "provider/other" } },
    });
    const context = modelRequestDigests({
      ...attributes,
      context: { items: [{ value: "preferred palette" }], contributors: [] },
    });

    expect(text.prompt).not.toBe(baseline.prompt);
    expect(media.prompt).not.toBe(baseline.prompt);
    expect(toolOutput.tools).not.toBe(baseline.tools);
    expect(toolOutput.configuration).not.toBe(baseline.configuration);
    expect(output.output).not.toBe(baseline.output);
    expect(model.model).not.toBe(baseline.model);
    expect(context.context).not.toBe(baseline.context);
  });
});

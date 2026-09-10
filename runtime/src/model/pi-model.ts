import { join } from "node:path";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  JsonValue,
  JsonObject,
  PromptContentPart,
  RuntimeModelAdapter,
  RuntimeModelCandidate,
} from "../contracts.js";
import type { RuntimeMedia } from "../adapters/media.js";
import { scrub } from "../adapters/journal.js";
import { ProjectCredentialStore } from "./auth-store.js";
import { modelsFor, type Selection } from "./models.js";
import { modelSelection, projectSecrets } from "./settings.js";

export interface PiModelOptions {
  readonly root?: string;
  readonly selection?: Selection;
  readonly media?: Pick<RuntimeMedia, "dataUrl">;
}
const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  totalTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** A plain portable callable. Provider credentials are read only when it is invoked. */
export function piModel(options: PiModelOptions = {}): RuntimeModelAdapter {
  return async (call, context) => {
    context.signal.throwIfAborted();
    const root = options.root ?? process.cwd();
    const selection = options.selection ?? modelSelection(root);
    const registry = modelsFor(
      selection,
      new ProjectCredentialStore(join(root, ".env", "auth.json")),
    );
    const selected = registry.getModel(selection.provider, selection.model);
    if (!selected) throw new Error("Unknown model. Run nylorun configure.");
    const signatureFor = (part: PromptContentPart): string | undefined => {
      const metadata =
        "providerMetadata" in part ? part.providerMetadata?.pi : undefined;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        return;
      if (
        !("provider" in metadata) ||
        metadata.provider !== selected.provider ||
        !("model" in metadata) ||
        metadata.model !== selected.id ||
        !("signature" in metadata) ||
        typeof metadata.signature !== "string"
      )
        return;
      return metadata.signature;
    };
    const metadataFor = (
      signature: string | undefined,
      redacted?: boolean,
    ): { providerMetadata?: JsonObject } =>
      signature === undefined
        ? {}
        : {
            providerMetadata: {
              pi: {
                provider: selected.provider,
                model: selected.id,
                signature,
                ...(redacted ? { redacted: true } : {}),
              },
            },
          };
    const messages: Message[] = [];
    const instructions: string[] = [];
    const content = async (
      parts: readonly PromptContentPart[],
    ): Promise<(TextContent | ImageContent)[]> => {
      const result: (TextContent | ImageContent)[] = [];
      for (const part of parts) {
        if (part.type === "text")
          result.push({ type: "text", text: part.text });
        else if (part.type === "media") {
          if (!selected.input.includes("image"))
            throw new Error("The configured model does not accept images.");
          const ref = part.reference;
          if (
            !ref ||
            typeof ref !== "object" ||
            Array.isArray(ref) ||
            !("agentId" in ref) ||
            !("assetId" in ref) ||
            typeof ref.agentId !== "string" ||
            typeof ref.assetId !== "string"
          )
            throw new Error("Expected a local media reference.");
          const asset = await options.media?.dataUrl(
            { agentId: ref.agentId, assetId: ref.assetId },
            call.sessionId,
          );
          if (!asset)
            throw new Error(
              "Media is unavailable; pass the shared media adapter to piModel({ media }).",
            );
          const comma = asset.url.indexOf(",");
          result.push({
            type: "image",
            data: asset.url.slice(comma + 1),
            mimeType: asset.asset.mediaType,
          });
        }
      }
      return result;
    };
    for (const item of call.prompt) {
      if (item.kind === "instructions") {
        instructions.push(
          ...item.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          ),
        );
      } else if (item.kind === "tool-result") {
        messages.push({
          role: "toolResult",
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          isError: item.status !== "completed",
          timestamp: Date.now(),
          content: await content(item.content),
        });
      } else if (item.role === "assistant") {
        messages.push({
          role: "assistant",
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
          timestamp: Date.now(),
          usage: emptyUsage(),
          stopReason: item.content.some((p) => p.type === "tool-call")
            ? "toolUse"
            : "stop",
          content: item.content.flatMap<AssistantMessage["content"][number]>(
            (part) =>
              part.type === "tool-call"
                ? [
                    {
                      type: "toolCall" as const,
                      id: part.id,
                      name: part.name,
                      arguments: { ...part.args },
                      ...(signatureFor(part) === undefined
                        ? {}
                        : { thoughtSignature: signatureFor(part) }),
                    },
                  ]
                : part.type === "text"
                  ? [
                      {
                        type: "text" as const,
                        text: part.text,
                        ...(signatureFor(part) === undefined
                          ? {}
                          : { textSignature: signatureFor(part) }),
                      },
                    ]
                  : part.type === "reasoning" &&
                      signatureFor(part) !== undefined
                    ? [
                        {
                          type: "thinking" as const,
                          thinking: part.text,
                          thinkingSignature: signatureFor(part),
                          ...(typeof part.providerMetadata?.pi === "object" &&
                          part.providerMetadata.pi !== null &&
                          "redacted" in part.providerMetadata.pi &&
                          part.providerMetadata.pi.redacted === true
                            ? { redacted: true }
                            : {}),
                        },
                      ]
                    : [],
          ),
        });
      } else
        messages.push({
          role: "user",
          content: await content(item.content),
          timestamp: Date.now(),
        });
    }
    const tools: Tool[] = call.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: { ...tool.inputSchema },
    }));
    const request: Context = {
      systemPrompt: instructions.join("\n"),
      messages,
      tools,
    };
    const secrets = projectSecrets(root);
    // Publish only portable references, never the materialized provider image bytes.
    context.reportPreparedCall?.({
      adapter: "runtime.pi-ai",
      call: scrub(call, secrets) as JsonValue,
    });
    try {
      const response = await registry.complete(selected, request, {
        signal: context.signal,
        temperature: call.model?.controls?.temperature,
        maxTokens: call.model?.controls?.maxOutputTokens,
        ...(call.model?.config
          ? { samplingParams: { ...call.model.config } }
          : {}),
      });
      context.signal.throwIfAborted();
      if (
        response.stopReason === "error" ||
        response.stopReason === "aborted" ||
        response.stopReason === "deferred"
      )
        throw new Error(
          response.errorMessage ?? `Provider stopped: ${response.stopReason}`,
        );
      const output: RuntimeModelCandidate["output"][number][] = [];
      for (const part of response.content) {
        if (part.type === "text")
          output.push({
            type: "text",
            text: part.text,
            ...metadataFor(part.textSignature),
          });
        else if (part.type === "thinking")
          output.push({
            type: "reasoning",
            text: part.thinking,
            ...metadataFor(part.thinkingSignature, part.redacted),
          });
        else if (part.type === "toolCall")
          output.push({
            type: "tool-call",
            id: part.id,
            name: part.name,
            args: part.arguments,
            ...metadataFor(part.thoughtSignature),
          });
      }
      return {
        output,
        finishReason:
          response.stopReason === "toolUse"
            ? "tool-calls"
            : response.stopReason === "length"
              ? "length"
              : "stop",
        usage: {
          inputTokens: response.usage.input,
          outputTokens: response.usage.output,
          totalTokens: response.usage.totalTokens,
          costUsd: response.usage.cost.total,
        },
        evidence: { resolvedModel: response.responseModel ?? selected.id },
      };
    } catch (error) {
      throw new Error(
        String(
          scrub(
            error instanceof Error ? error.message : String(error),
            projectSecrets(root),
          ),
        ),
      );
    }
  };
}

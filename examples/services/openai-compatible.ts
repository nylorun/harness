import {
  preparedModel,
  type JsonValue,
  type ModelAdapter,
  type ModelCall,
  type PromptContentPart,
  type PromptItem,
} from "@nylorun/harness";
import {
  fromChatCompletions,
  toChatCompletions,
  type ChatCompletionsRequest,
} from "@nylorun/harness/model/adapters";
import { type MediaReference, type MediaStore } from "./media.js";

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional examples-host resolver for opaque local image references. */
  readonly media?: MediaStore;
}

/** Send Harness calls through any OpenAI-compatible Chat Completions endpoint. */
export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleOptions,
): ModelAdapter {
  const url = new URL(
    "chat/completions",
    options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
  );
  return preparedModel({
    adapter: "examples.openai-compatible",
    async prepare(call) {
      const materialized = await materialize(call, options.media);
      const request = toChatCompletions(materialized.call);
      return {
        request,
        observed: redactInlineMedia(request, materialized.urls),
      };
    },
    async send(body, call, { signal }) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify({
          model: options.model,
          ...call.model?.config,
          ...body,
        }),
        signal,
      });
      if (!response.ok)
        throw new Error(
          `Model request failed (${response.status}): ${await response.text()}`,
        );
      return response.json();
    },
    decode: fromChatCompletions,
  });
}

async function materialize(
  call: ModelCall,
  media: MediaStore | undefined,
): Promise<{
  readonly call: ModelCall;
  readonly urls: ReadonlyMap<string, string>;
}> {
  const urls = new Map<string, string>();
  const prompt = await Promise.all(
    call.prompt.map(
      async (item) =>
        Object.freeze({
          ...item,
          content: Object.freeze(
            await Promise.all(
              item.content.map((part) =>
                materializePart(part, call.sessionId, media, urls),
              ),
            ),
          ),
        }) as PromptItem,
    ),
  );
  return Object.freeze({
    call: Object.freeze({ ...call, prompt: Object.freeze(prompt) }),
    urls,
  });
}

async function materializePart(
  part: PromptContentPart,
  sessionId: string,
  media: MediaStore | undefined,
  urls: Map<string, string>,
): Promise<PromptContentPart> {
  if (part.type !== "media") return part;
  const reference = localReference(part.reference);
  if (!reference) return part;
  if (!media)
    throw new Error(
      "This adapter cannot resolve local media without an examples MediaStore.",
    );
  const asset = await media.dataUrl(reference, sessionId);
  if (!asset)
    throw new Error(
      "The local image referenced by this model call is unavailable.",
    );
  urls.set(asset.url, `asset://${reference.agentId}/${reference.assetId}`);
  return Object.freeze({ ...part, reference: { url: asset.url } });
}

function localReference(value: JsonValue): MediaReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const reference = value as Partial<MediaReference>;
  return typeof reference.agentId === "string" &&
    typeof reference.assetId === "string"
    ? { agentId: reference.agentId, assetId: reference.assetId }
    : undefined;
}

function redactInlineMedia(
  request: ChatCompletionsRequest,
  urls: ReadonlyMap<string, string>,
): JsonValue {
  return redact(request, urls) as JsonValue;
}

function redact(value: unknown, urls: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string")
    return (
      urls.get(value) ??
      (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)
        ? "[inline image data redacted]"
        : value)
    );
  if (Array.isArray(value)) return value.map((item) => redact(item, urls));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redact(item, urls),
      ]),
    );
  return value;
}

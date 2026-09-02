import { chatCompletionsAdapter } from "@nylorun/harness/model/adapters";
import type { ModelAdapter } from "@nylorun/harness";

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Send Harness calls through any OpenAI-compatible Chat Completions endpoint. */
export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleOptions,
): ModelAdapter {
  const url = new URL(
    "chat/completions",
    options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
  );
  return chatCompletionsAdapter(async (body, call, { signal }) => {
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
  });
}

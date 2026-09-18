import type {
  ModelAdapter,
  ModelCandidate,
  PromptContentPart,
  JsonObject,
} from "@nylorun/harness";
import type { ModelFactoryOptions } from "./defaults.js";

export type ModelEnvironment = Readonly<Record<string, string | undefined>>;
export interface HttpModelOptions extends ModelFactoryOptions {
  readonly provider?: "openai" | "custom" | "anthropic";
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/** Fetch-only adapter for OpenAI-compatible and Anthropic HTTP endpoints. */
export function httpModel(options: HttpModelOptions = {}): ModelAdapter {
  return async (call, context) => {
    const env =
      options.environment ??
      (typeof process === "undefined" ? {} : process.env);
    const provider = options.provider ?? env.MODEL_PROVIDER;
    const model = call.model?.id ?? options.model ?? env.MODEL;
    const baseUrl = options.baseUrl ?? env.MODEL_PROVIDER_BASE_URL;
    if (!provider || !model)
      throw new Error(
        "Set both MODEL_PROVIDER and MODEL, or supply a model adapter.",
      );
    if (!["openai", "custom", "anthropic"].includes(provider))
      throw new Error(
        `The portable HTTP adapter does not support '${provider}'. Supply onModelCall or use the Node piModel adapter.`,
      );
    if (provider === "custom" && !baseUrl)
      throw new Error(
        "MODEL_PROVIDER=custom requires MODEL_PROVIDER_BASE_URL.",
      );
    const apiKey =
      options.apiKey ??
      env.MODEL_PROVIDER_API_KEY ??
      (provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
    if (!apiKey)
      throw new Error(
        "Set MODEL_PROVIDER_API_KEY or the provider-native API key variable.",
      );
    const text = (parts: readonly PromptContentPart[]) =>
      parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
    if (
      call.prompt.some((item) =>
        item.content.some((part) => part.type === "media"),
      )
    )
      throw new Error("Supply a media-aware model adapter for media inputs.");
    context.signal.throwIfAborted();
    let body: Record<string, unknown>;
    let url: string;
    let headers: Record<string, string>;
    const streaming =
      provider !== "anthropic" && options.onPreview !== undefined;
    if (provider === "anthropic") {
      const messages = call.prompt
        .filter((item) => item.kind !== "instructions")
        .map((item) => {
          if (item.kind === "tool-result")
            return {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.toolCallId,
                  content: text(item.content),
                  is_error: item.status !== "completed",
                },
              ],
            };
          return {
            role: item.role === "assistant" ? "assistant" : "user",
            content: item.content.flatMap<Record<string, unknown>>((part) =>
              part.type === "tool-call"
                ? [
                    {
                      type: "tool_use",
                      id: part.id,
                      name: part.name,
                      input: part.args,
                    },
                  ]
                : part.type === "text"
                  ? [{ type: "text", text: part.text }]
                  : [],
            ),
          };
        });
      body = {
        model,
        messages,
        max_tokens: call.model?.controls?.maxOutputTokens ?? 4096,
        system: call.prompt
          .filter((item) => item.kind === "instructions")
          .map((item) => text(item.content))
          .join("\n"),
        ...(call.tools.length
          ? {
              tools: call.tools.map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
        ...(call.outputSchema
          ? {
              output_config: {
                format: { type: "json_schema", schema: call.outputSchema },
              },
            }
          : {}),
        ...(call.model?.controls?.temperature === undefined
          ? {}
          : { temperature: call.model.controls.temperature }),
      };
      url = `${(baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
      headers = {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    } else {
      const messages = call.prompt.map((item) => {
        if (item.kind === "tool-result")
          return {
            role: "tool",
            tool_call_id: item.toolCallId,
            content: text(item.content),
          };
        const calls = item.content
          .filter((part) => part.type === "tool-call")
          .map((part) => ({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.args) },
          }));
        return {
          role: item.kind === "instructions" ? "system" : item.role,
          content: text(item.content),
          ...(calls.length ? { tool_calls: calls } : {}),
        };
      });
      body = {
        model,
        messages,
        stream: streaming,
        ...(call.tools.length
          ? {
              tools: call.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          : {}),
        ...(call.outputSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "agent_output",
                  strict: true,
                  schema: call.outputSchema,
                },
              },
            }
          : {}),
        ...(call.model?.controls?.temperature === undefined
          ? {}
          : { temperature: call.model.controls.temperature }),
        ...(call.model?.controls?.maxOutputTokens === undefined
          ? {}
          : { max_completion_tokens: call.model.controls.maxOutputTokens }),
      };
      url = `${(baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
      headers = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      };
    }
    if (!["https:", "http:"].includes(new URL(url).protocol))
      throw new Error("Model endpoint must use HTTP(S).");
    context.reportPreparedCall?.({
      adapter: "runtime.http",
      call: JSON.parse(JSON.stringify(body)),
    });
    const response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: context.signal,
    });
    if (!response.ok)
      throw new Error(
        `Model provider returned HTTP ${response.status}. Check the selected model, credentials, and endpoint.`,
      );
    let result: any;
    if (streaming)
      result = await readOpenAIStream(response, (value) => {
        try {
          void Promise.resolve(
            options.onPreview?.({
              invocationId: context.invocationId,
              text: value,
            }),
          ).catch(() => {});
        } catch {
          /* Preview delivery cannot affect generation. */
        }
      });
    else result = await response.json();
    context.signal.throwIfAborted();
    const output: ModelCandidate["output"][number][] = [];
    if (provider === "anthropic") {
      for (const part of result.content ?? []) {
        if (part.type === "text")
          output.push(
            call.outputSchema &&
              !(result.content ?? []).some(
                (item: { type: string }) => item.type === "tool_use",
              )
              ? { type: "json", value: JSON.parse(part.text) }
              : { type: "text", text: part.text },
          );
        if (part.type === "tool_use")
          output.push({
            type: "tool-call",
            id: part.id,
            name: part.name,
            args: part.input,
          });
      }
    } else {
      const message = result.choices?.[0]?.message;
      if (!message) throw new Error("Model provider returned no message.");
      if (message.content)
        output.push(
          call.outputSchema && !message.tool_calls?.length
            ? { type: "json", value: JSON.parse(message.content) }
            : { type: "text", text: message.content },
        );
      for (const tool of message.tool_calls ?? [])
        output.push({
          type: "tool-call",
          id: tool.id,
          name: tool.function.name,
          args: JSON.parse(tool.function.arguments) as JsonObject,
        });
    }
    return { output, evidence: { resolvedModel: result.model ?? model } };
  };
}

async function readOpenAIStream(
  response: Response,
  preview: (text: string) => void,
): Promise<unknown> {
  if (!response.body) throw new Error("Model provider returned no stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    content = "",
    complete = false;
  const calls = new Map<
    number,
    {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }
  >();
  const line = (value: string) => {
    if (!value.startsWith("data:")) return;
    const data = value.slice(5).trim();
    if (data === "[DONE]") {
      complete = true;
      return;
    }
    if (!data) return;
    const chunk = JSON.parse(data);
    if (chunk.error)
      throw new Error("Model provider reported a streaming error.");
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string") {
      content += delta.content;
      preview(delta.content);
    }
    for (const tool of delta?.tool_calls ?? []) {
      const target = calls.get(tool.index) ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (tool.id) target.id = tool.id;
      if (tool.function?.name) target.function.name += tool.function.name;
      if (tool.function?.arguments)
        target.function.arguments += tool.function.arguments;
      calls.set(tool.index, target);
    }
  };
  try {
    while (!complete) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
      }
      if (next.done) {
        if (buffer) line(buffer);
        break;
      }
    }
    if (!complete) throw new Error("Model stream ended before completion.");
    return {
      choices: [
        {
          message: {
            content,
            tool_calls: [...calls]
              .sort(([a], [b]) => a - b)
              .map(([, value]) => value),
          },
        },
      ],
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

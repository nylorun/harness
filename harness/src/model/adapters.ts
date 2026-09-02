import { HarnessError } from "../errors.js";
import type {
  ModelAdapter,
  ModelAdapterContext,
  ModelCall,
  ModelCandidate,
  ModelFinishReason,
  ModelOutputBlock,
  ModelUsage,
  PromptContentPart,
  PromptItem,
} from "../types/model.js";
import type { JsonObject } from "../types/shared.js";
import { copyJsonObject } from "../utils/immutable.js";

export type ChatCompletionsMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly ChatCompletionsToolCall[];
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

export interface ChatCompletionsToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: Readonly<{ name: string; arguments: string }>;
}

export interface ChatCompletionsRequest {
  readonly messages: readonly ChatCompletionsMessage[];
  readonly tools?: readonly Readonly<{
    type: "function";
    function: Readonly<{ name: string; description?: string; parameters: JsonObject }>;
  }>[];
  readonly temperature?: number;
  readonly max_completion_tokens?: number;
}

export interface ResponsesRequest {
  readonly instructions?: string;
  readonly input: readonly ResponsesInputItem[];
  readonly tools?: readonly Readonly<{
    type: "function";
    name: string;
    description?: string;
    parameters: JsonObject;
  }>[];
  readonly temperature?: number;
  readonly max_output_tokens?: number;
}

export type ResponsesInputItem =
  | { readonly type: "message"; readonly role: "user" | "assistant"; readonly content: string }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string };

export interface MessagesRequest {
  readonly system?: string;
  readonly messages: readonly MessagesMessage[];
  readonly tools?: readonly Readonly<{
    name: string;
    description?: string;
    input_schema: JsonObject;
  }>[];
  readonly temperature?: number;
  readonly max_tokens: number;
}

export type MessagesMessage =
  | { readonly role: "user"; readonly content: string | readonly MessagesToolResult[] }
  | { readonly role: "assistant"; readonly content: readonly MessagesAssistantPart[] };

export type MessagesAssistantPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: JsonObject;
    };

export interface MessagesToolResult {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export type AdapterSend<Request> = (
  request: Request,
  call: ModelCall,
  context: ModelAdapterContext,
) => Promise<unknown>;

export interface AnthropicAdapterOptions {
  readonly defaultMaxOutputTokens: number;
  readonly send: AdapterSend<MessagesRequest>;
}

/** Translate a Harness call to the OpenAI Chat Completions request shape. */
export function toChatCompletions(call: ModelCall): ChatCompletionsRequest {
  const messages = call.prompt.map((item): ChatCompletionsMessage => {
    if (item.kind === "instructions") return { role: "system", content: textOf(item) };
    if (item.kind === "tool-result")
      return { role: "tool", tool_call_id: item.toolCallId, content: textOf(item) };
    if (item.kind === "message" && item.role === "assistant") {
      const toolCalls = toolCallsOf(item.content).map((part) => ({
        id: part.id,
        type: "function" as const,
        function: { name: part.name, arguments: JSON.stringify(part.args) },
      }));
      const text = textOf(item);
      return {
        role: "assistant",
        content: text === "" ? null : text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      };
    }
    return { role: "user", content: textOf(item) };
  });
  return {
    messages,
    ...(call.tools.length === 0
      ? {}
      : {
          tools: call.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              parameters: tool.inputSchema,
            },
          })),
        }),
    ...chatControls(call),
  };
}

/** Translate a Chat Completions response into a Harness candidate. */
export function fromChatCompletions(value: unknown): ModelCandidate {
  const response = record(value, "response");
  const choices = array(response.choices, "response.choices");
  if (choices.length === 0)
    throw invalidResponse("response.choices must contain a choice", "response.choices");
  const choice = record(choices[0], "response.choices[0]");
  const message = record(choice.message, "response.choices[0].message");
  const output: ModelOutputBlock[] = [];
  if (typeof message.content === "string" && message.content !== "")
    output.push({ type: "text", text: message.content });
  if (typeof message.reasoning_content === "string" && message.reasoning_content !== "")
    output.push({ type: "reasoning", text: message.reasoning_content });
  for (const [index, raw] of optionalArray(
    message.tool_calls,
    "response.choices[0].message.tool_calls",
  ).entries()) {
    const call = record(raw, `response.choices[0].message.tool_calls[${index}]`);
    const fn = record(call.function, `response.choices[0].message.tool_calls[${index}].function`);
    output.push({
      type: "tool-call",
      id: string(call.id, `response.choices[0].message.tool_calls[${index}].id`),
      name: string(fn.name, `response.choices[0].message.tool_calls[${index}].function.name`),
      ...argumentsOf(
        fn.arguments,
        `response.choices[0].message.tool_calls[${index}].function.arguments`,
      ),
    });
  }
  return candidate({
    output,
    finishReason: chatFinishReason(choice.finish_reason, output),
    usage: chatUsage(response.usage),
    evidence: evidence(response),
  });
}

/** Return a Harness adapter backed by an application-owned Chat Completions send function. */
export function chatCompletionsAdapter(send: AdapterSend<ChatCompletionsRequest>): ModelAdapter {
  return async (call, context) =>
    fromChatCompletions(await send(toChatCompletions(call), call, context));
}

/** Translate a Harness call to the OpenAI Responses request shape. */
export function toResponses(call: ModelCall): ResponsesRequest {
  const instructions = call.prompt.filter((item) => item.kind === "instructions").map(textOf);
  const input = call.prompt.flatMap((item): ResponsesInputItem[] => {
    if (item.kind === "instructions") return [];
    if (item.kind === "tool-result")
      return [{ type: "function_call_output", call_id: item.toolCallId, output: textOf(item) }];
    if (item.kind === "message" && item.role === "assistant") {
      const text = textOf(item);
      return [
        ...(text === ""
          ? []
          : [{ type: "message" as const, role: "assistant" as const, content: text }]),
        ...toolCallsOf(item.content).map((part) => ({
          type: "function_call" as const,
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.args),
        })),
      ];
    }
    return [{ type: "message", role: "user", content: textOf(item) }];
  });
  return {
    ...(instructions.length === 0 ? {} : { instructions: instructions.join("\n\n") }),
    input,
    ...(call.tools.length === 0
      ? {}
      : {
          tools: call.tools.map((tool) => ({
            type: "function" as const,
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            parameters: tool.inputSchema,
          })),
        }),
    ...responsesControls(call),
  };
}

/** Translate an OpenAI Responses response into a Harness candidate. */
export function fromResponses(value: unknown): ModelCandidate {
  const response = record(value, "response");
  if (response.error !== undefined && response.error !== null)
    throw invalidResponse("response.error is present", "response.error");
  const output: ModelOutputBlock[] = [];
  for (const [index, raw] of array(response.output, "response.output").entries()) {
    const item = record(raw, `response.output[${index}]`);
    if (item.type === "function_call") {
      output.push({
        type: "tool-call",
        id: string(item.call_id, `response.output[${index}].call_id`),
        name: string(item.name, `response.output[${index}].name`),
        ...argumentsOf(item.arguments, `response.output[${index}].arguments`),
      });
      continue;
    }
    if (item.type === "message") {
      for (const [partIndex, rawPart] of optionalArray(
        item.content,
        `response.output[${index}].content`,
      ).entries()) {
        const part = record(rawPart, `response.output[${index}].content[${partIndex}]`);
        if (part.type === "output_text" && typeof part.text === "string")
          output.push({ type: "text", text: part.text });
      }
      continue;
    }
    if (item.type === "reasoning") {
      const summary = optionalArray(item.summary, `response.output[${index}].summary`)
        .map((rawPart, partIndex) =>
          record(rawPart, `response.output[${index}].summary[${partIndex}]`),
        )
        .filter((part) => part.type === "summary_text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      if (summary !== "") output.push({ type: "reasoning", text: summary });
    }
  }
  return candidate({
    output,
    finishReason: responsesFinishReason(response, output),
    usage: responsesUsage(response.usage),
    evidence: evidence(response),
  });
}

/** Return a Harness adapter backed by an application-owned Responses send function. */
export function responsesAdapter(send: AdapterSend<ResponsesRequest>): ModelAdapter {
  return async (call, context) => fromResponses(await send(toResponses(call), call, context));
}

/** Translate a Harness call to the Anthropic Messages request shape. */
export function toMessages(call: ModelCall, defaultMaxOutputTokens: number): MessagesRequest {
  checkedMaxOutputTokens(defaultMaxOutputTokens);
  const instructions = call.prompt.filter((item) => item.kind === "instructions").map(textOf);
  const messages = call.prompt.flatMap((item): MessagesMessage[] => {
    if (item.kind === "instructions") return [];
    if (item.kind === "tool-result")
      return [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: item.toolCallId,
              content: textOf(item),
              ...(item.status === "completed" ? {} : { is_error: true }),
            },
          ],
        },
      ];
    if (item.kind === "message" && item.role === "assistant")
      return [
        {
          role: "assistant",
          content: item.content.map((part): MessagesAssistantPart =>
            part.type === "text"
              ? { type: "text", text: part.text }
              : { type: "tool_use", id: part.id, name: part.name, input: part.args },
          ),
        },
      ];
    return [{ role: "user", content: textOf(item) }];
  });
  return {
    ...(instructions.length === 0 ? {} : { system: instructions.join("\n\n") }),
    messages,
    ...(call.tools.length === 0
      ? {}
      : {
          tools: call.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            input_schema: tool.inputSchema,
          })),
        }),
    ...(call.model?.controls?.temperature === undefined
      ? {}
      : { temperature: call.model.controls.temperature }),
    max_tokens: call.model?.controls?.maxOutputTokens ?? defaultMaxOutputTokens,
  };
}

/** Translate an Anthropic Messages response into a Harness candidate. */
export function fromMessages(value: unknown): ModelCandidate {
  const response = record(value, "response");
  const output: ModelOutputBlock[] = [];
  for (const [index, raw] of array(response.content, "response.content").entries()) {
    const part = record(raw, `response.content[${index}]`);
    if (part.type === "text" && typeof part.text === "string") {
      output.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "thinking" && typeof part.thinking === "string") {
      output.push({ type: "reasoning", text: part.thinking });
      continue;
    }
    if (part.type === "tool_use") {
      output.push({
        type: "tool-call",
        id: string(part.id, `response.content[${index}].id`),
        name: string(part.name, `response.content[${index}].name`),
        args: jsonObject(part.input, `response.content[${index}].input`),
      });
    }
  }
  return candidate({
    output,
    finishReason: messagesFinishReason(response.stop_reason, output),
    usage: messagesUsage(response.usage),
    evidence: evidence(response),
  });
}

/** Return a Harness adapter backed by an application-owned Anthropic Messages send function. */
export function anthropicAdapter(options: AnthropicAdapterOptions): ModelAdapter {
  checkedMaxOutputTokens(options.defaultMaxOutputTokens);
  return async (call, context) =>
    fromMessages(
      await options.send(toMessages(call, options.defaultMaxOutputTokens), call, context),
    );
}

function textOf(item: PromptItem): string {
  return item.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toolCallsOf(parts: readonly PromptContentPart[]) {
  return parts.filter(
    (part): part is Extract<PromptContentPart, { type: "tool-call" }> => part.type === "tool-call",
  );
}

function chatControls(
  call: ModelCall,
): Pick<ChatCompletionsRequest, "temperature" | "max_completion_tokens"> {
  return {
    ...(call.model?.controls?.temperature === undefined
      ? {}
      : { temperature: call.model.controls.temperature }),
    ...(call.model?.controls?.maxOutputTokens === undefined
      ? {}
      : { max_completion_tokens: call.model.controls.maxOutputTokens }),
  };
}

function responsesControls(
  call: ModelCall,
): Pick<ResponsesRequest, "temperature" | "max_output_tokens"> {
  return {
    ...(call.model?.controls?.temperature === undefined
      ? {}
      : { temperature: call.model.controls.temperature }),
    ...(call.model?.controls?.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: call.model.controls.maxOutputTokens }),
  };
}

function argumentsOf(
  value: unknown,
  path: string,
): Pick<Extract<ModelOutputBlock, { type: "tool-call" }>, "args" | "raw"> {
  const raw = string(value, path);
  try {
    return { args: jsonObject(JSON.parse(raw), path), raw };
  } catch (error) {
    throw invalidResponse(`${path} must be a JSON object`, path, error);
  }
}

function jsonObject(value: unknown, path: string): JsonObject {
  try {
    return copyJsonObject(value, path);
  } catch (error) {
    throw invalidResponse(`${path} must be a JSON object`, path, error);
  }
}

function candidate(value: ModelCandidate): ModelCandidate {
  return {
    output: value.output,
    ...(value.finishReason === undefined ? {} : { finishReason: value.finishReason }),
    ...(value.usage === undefined ? {} : { usage: value.usage }),
    ...(value.evidence === undefined ? {} : { evidence: value.evidence }),
  };
}

function chatFinishReason(value: unknown, output: readonly ModelOutputBlock[]): ModelFinishReason {
  if (value === "tool_calls" || value === "function_call") return "tool-calls";
  if (value === "length") return "length";
  if (value === "content_filter") return "content-filter";
  if (value === "stop" || value === null || value === undefined)
    return hasToolCall(output) ? "tool-calls" : "stop";
  return "other";
}

function responsesFinishReason(
  response: Record<string, unknown>,
  output: readonly ModelOutputBlock[],
): ModelFinishReason {
  if (response.status === "incomplete") {
    const details =
      response.incomplete_details === undefined
        ? undefined
        : record(response.incomplete_details, "response.incomplete_details");
    return details?.reason === "max_output_tokens" ? "length" : "other";
  }
  if (response.status === "failed" || response.status === "cancelled")
    throw invalidResponse(`response.status is ${String(response.status)}`, "response.status");
  return hasToolCall(output) ? "tool-calls" : "stop";
}

function messagesFinishReason(
  value: unknown,
  output: readonly ModelOutputBlock[],
): ModelFinishReason {
  if (value === "tool_use") return "tool-calls";
  if (value === "max_tokens") return "length";
  if (value === "end_turn" || value === "stop_sequence" || value === undefined || value === null)
    return hasToolCall(output) ? "tool-calls" : "stop";
  return "other";
}

function chatUsage(value: unknown): ModelUsage | undefined {
  const usage = optionalRecord(value, "response.usage");
  if (usage === undefined) return undefined;
  return usageOf(
    {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: optionalRecord(
        usage.prompt_tokens_details,
        "response.usage.prompt_tokens_details",
      )?.cached_tokens,
      reasoningTokens: optionalRecord(
        usage.completion_tokens_details,
        "response.usage.completion_tokens_details",
      )?.reasoning_tokens,
    },
    "response.usage",
  );
}

function responsesUsage(value: unknown): ModelUsage | undefined {
  const usage = optionalRecord(value, "response.usage");
  if (usage === undefined) return undefined;
  return usageOf(
    {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: optionalRecord(
        usage.input_tokens_details,
        "response.usage.input_tokens_details",
      )?.cached_tokens,
      reasoningTokens: optionalRecord(
        usage.output_tokens_details,
        "response.usage.output_tokens_details",
      )?.reasoning_tokens,
    },
    "response.usage",
  );
}

function messagesUsage(value: unknown): ModelUsage | undefined {
  const usage = optionalRecord(value, "response.usage");
  if (usage === undefined) return undefined;
  return usageOf(
    {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedTokens: usage.cache_read_input_tokens,
    },
    "response.usage",
  );
}

function usageOf(value: Record<string, unknown>, path: string): ModelUsage {
  const fields = Object.entries(value).flatMap(([key, raw]) => {
    if (raw === undefined) return [];
    if (!isNonNegativeInteger(raw))
      throw invalidResponse(`${path}.${key} must be a non-negative integer`, `${path}.${key}`);
    return [[key, raw] as const];
  });
  return Object.fromEntries(fields) as ModelUsage;
}

function evidence(response: Record<string, unknown>): ModelCandidate["evidence"] | undefined {
  const requestId = optionalString(response.id, "response.id");
  const resolvedModel = optionalString(response.model, "response.model");
  return requestId === undefined && resolvedModel === undefined
    ? undefined
    : {
        ...(requestId === undefined ? {} : { requestId }),
        ...(resolvedModel === undefined ? {} : { resolvedModel }),
      };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidResponse(`${path} must be an object`, path);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : record(value, path);
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidResponse(`${path} must be an array`, path);
  return value;
}

function optionalArray(value: unknown, path: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidResponse(`${path} must be an array`, path);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw invalidResponse(`${path} must be a string`, path);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return string(value, path);
}

function checkedMaxOutputTokens(value: number): void {
  if (!isNonNegativeInteger(value))
    throw new HarnessError(
      "model.adapter-invalid-options",
      "Anthropic defaultMaxOutputTokens must be a non-negative integer",
      { details: { path: "defaultMaxOutputTokens" } },
    );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasToolCall(output: readonly ModelOutputBlock[]): boolean {
  return output.some((part) => part.type === "tool-call");
}

function invalidResponse(message: string, path: string, cause?: unknown): HarnessError {
  return new HarnessError("model.adapter-invalid-response", message, {
    ...(cause === undefined ? {} : { cause }),
    details: { path },
  });
}

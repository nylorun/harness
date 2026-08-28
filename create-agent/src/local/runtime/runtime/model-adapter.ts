import type {
  JsonObject,
  JsonValue,
  ModelCall,
  ModelAdapterContext,
  ModelCandidate,
  ModelToolCall,
} from "@nylorun/harness";
import type {
  ChatMessage,
  ModelGatewayAdapter,
  ModelGatewayCallEvidence,
  ModelGatewayUsage,
} from "./contracts.js";

export class GatewayModelAdapter {
  readonly #model: string;

  constructor(
    model: string,
    private readonly gateway: ModelGatewayAdapter,
    private readonly onCall?: (
      details: Readonly<{
        sessionId: string;
        usage: ModelGatewayUsage;
        evidence?: ModelGatewayCallEvidence;
        content: string;
        toolCalls: readonly ModelToolCall[];
      }>,
    ) => void,
  ) {
    this.#model = model;
  }

  async invoke(
    call: ModelCall,
    { signal }: ModelAdapterContext,
  ): Promise<ModelCandidate> {
    const content: string[] = [];
    const calls = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();
    let usage: ModelGatewayUsage = { tokensIn: 0, tokensOut: 0 };
    let evidence: ModelGatewayCallEvidence | undefined;
    for await (const chunk of this.gateway.complete(
      {
        model: call.model?.id ?? this.#model,
        messages: messages(call),
        tools: call.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          inputSchema: tool.inputSchema,
        })),
        maxOutputTokens: 4096,
      },
      signal,
    )) {
      if (chunk.type === "text") content.push(chunk.text);
      else if (chunk.type === "tool-call") {
        const current = calls.get(chunk.index) ?? { arguments: "" };
        if (chunk.id !== undefined) current.id = chunk.id;
        if (chunk.name !== undefined) current.name = chunk.name;
        if (chunk.arguments !== undefined) current.arguments += chunk.arguments;
        calls.set(chunk.index, current);
      } else {
        usage = chunk.usage;
        evidence = chunk.evidence;
      }
    }
    const toolCalls = Object.freeze(
      [...calls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => ({
          id: call.id ?? `call-${index}`,
          name: call.name ?? "unknown_tool",
          args: parseArguments(call.arguments),
        })),
    );
    const text = content.join("");
    this.onCall?.({
      sessionId: call.sessionId,
      usage,
      ...(evidence === undefined ? {} : { evidence }),
      content: text,
      toolCalls,
    });
    return Object.freeze({
      output: [
        ...(text === "" ? [] : [{ type: "text" as const, text }]),
        ...toolCalls.map((item) => ({
          type: "tool-call" as const,
          id: item.id,
          name: item.name,
          args: item.args,
        })),
      ],
      finishReason:
        toolCalls.length > 0 ? ("tool-calls" as const) : ("stop" as const),
      usage: {
        inputTokens: usage.tokensIn,
        outputTokens: usage.tokensOut,
        ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      },
      ...(evidence === undefined
        ? {}
        : { evidence: evidence as ModelCandidate["evidence"] }),
    });
  }
}

function messages(call: ModelCall): ChatMessage[] {
  const output: ChatMessage[] = [];
  for (const item of call.prompt) {
    if (item.kind === "instructions") {
      const text = textOf(item.content);
      if (text !== "") output.push({ role: "system", content: text });
      continue;
    }
    if (item.kind === "context") {
      output.push({ role: "user", content: textOf(item.content) });
      continue;
    }
    if (item.kind === "tool-result") {
      output.push({
        role: "tool",
        toolCallId: item.toolCallId,
        content: textOf(item.content),
      });
      continue;
    }
    output.push(flattenMessage(item));
  }
  return output;
}

function flattenMessage(
  message: Extract<ModelCall["prompt"][number], { kind: "message" }>,
): ChatMessage {
  const text = textOf(message.content);
  const toolCalls = message.content.flatMap((part) =>
    part.type === "tool-call"
      ? [{ id: part.id, name: part.name, arguments: JSON.stringify(part.args) }]
      : [],
  );
  if (message.role === "user") return { role: "user", content: text };
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };
}

function textOf(content: ModelCall["prompt"][number]["content"]): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function parseArguments(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as JsonValue;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as JsonObject;
  } catch {
    /* empty object is a valid parse failure stand-in for adapter args */
  }
  return {};
}

import type { JsonValue, ModelCandidate, ModelInvoker, ModelRequest, ModelToolCall, TranscriptEntry } from "@nylorun/harness";
import type { ChatMessage, ModelGatewayAdapter, ModelGatewayCallEvidence, ModelGatewayUsage } from "./contracts.js";

export class GatewayModelInvoker implements ModelInvoker {
  readonly id: string;

  constructor(
    model: string,
    private readonly gateway: ModelGatewayAdapter,
    private readonly onCall?: (details: Readonly<{ sessionId: string; usage: ModelGatewayUsage; evidence?: ModelGatewayCallEvidence; content: string; toolCalls: readonly ModelToolCall[] }>) => void
  ) { this.id = model; }

  async invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelCandidate> {
    const content: string[] = [];
    const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
    let usage: ModelGatewayUsage = { tokensIn: 0, tokensOut: 0 };
    let evidence: ModelGatewayCallEvidence | undefined;
    for await (const chunk of this.gateway.complete({
      model: this.id,
      messages: messages(request),
      tools: request.tools.map((tool) => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: "jsonSchema" in tool.input ? tool.input.jsonSchema : {} })),
      maxOutputTokens: 4096
    }, signal)) {
      if (chunk.type === "text") content.push(chunk.text);
      else if (chunk.type === "tool-call") {
        const current = calls.get(chunk.index) ?? { arguments: "" };
        if (chunk.id !== undefined) current.id = chunk.id;
        if (chunk.name !== undefined) current.name = chunk.name;
        if (chunk.arguments !== undefined) current.arguments += chunk.arguments;
        calls.set(chunk.index, current);
      } else { usage = chunk.usage; evidence = chunk.evidence; }
    }
    const toolCalls = Object.freeze([...calls.entries()].sort(([left], [right]) => left - right).map(([index, call]) => ({ id: call.id ?? `call-${index}`, name: call.name ?? "unknown_tool", args: parseArguments(call.arguments) })));
    const text = content.join("");
    this.onCall?.({ sessionId: request.sessionId, usage, ...(evidence === undefined ? {} : { evidence }), content: text, toolCalls });
    return Object.freeze({ ...(text === "" ? {} : { content: text }), ...(toolCalls.length === 0 ? {} : { toolCalls }), metadata: metadata(usage, evidence) });
  }
}

function messages(request: ModelRequest): ChatMessage[] {
  const output: ChatMessage[] = [];
  if (request.instructions.length > 0) output.push({ role: "system", content: request.instructions.join("\n\n") });
  for (const entry of request.transcript) appendTranscript(output, entry);
  return output;
}

function appendTranscript(output: ChatMessage[], entry: TranscriptEntry): void {
  if (entry.kind === "input") {
    if (entry.event.kind === "user-message" || entry.event.kind === "interrupt") output.push({ role: "user", content: entry.event.text });
  } else if (entry.kind === "candidate") {
    output.push({ role: "assistant", content: entry.candidate.content ?? "", ...(entry.candidate.toolCalls === undefined ? {} : { toolCalls: entry.candidate.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.args) })) }) });
  } else if (entry.kind === "tool-results") {
    for (const result of entry.results) output.push({ role: "tool", toolCallId: result.callId, content: JSON.stringify(result.kind === "completed" ? result.output ?? null : { kind: result.kind, reason: result.reason ?? result.message ?? result.code ?? "failed" }) });
  }
  // A final entry mirrors its immediately preceding candidate and is deliberately not duplicated.
}

function parseArguments(value: string): JsonValue { try { return JSON.parse(value) as JsonValue; } catch { return {}; } }
function metadata(usage: ModelGatewayUsage, evidence: ModelGatewayCallEvidence | undefined): Record<string, JsonValue> {
  return { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }), ...(evidence === undefined ? {} : { evidence: evidence as unknown as JsonValue }) };
}

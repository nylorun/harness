import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ObserveEvent, ObserveModelRequested } from "@nylorun/harness";

export interface ModelRequestDigests {
  readonly prompt: string;
  readonly tools: string;
  readonly model: string;
  readonly output: string;
  readonly configuration: string;
  readonly context: string;
}

/** Adds examples-host metadata without changing the Harness observation contract. */
export function observedPayload(event: ObserveEvent): Record<string, unknown> {
  if (event.type !== "model.requested") return { ...event };
  return { ...event, digests: modelRequestDigests(event.attributes) };
}

export function modelRequestDigests(
  attributes: ObserveModelRequested,
): ModelRequestDigests {
  const prompt = digest(attributes.call.prompt);
  const tools = digest({
    call: attributes.call.tools,
    contracts: attributes.configuration.toolContracts,
  });
  const model = digest(attributes.call.model ?? null);
  return Object.freeze({
    prompt,
    tools,
    model,
    output: digest(attributes.call.outputSchema ?? null),
    configuration: digest(attributes.configuration),
    context: digest(attributes.context),
  });
}

function digest(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonical(value))));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

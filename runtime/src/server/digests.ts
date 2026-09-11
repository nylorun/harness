import { createHash } from "node:crypto";

/** Optional diagnostic enrichment; engines need not emit model diagnostics. */
export function observedPayload(
  event: { readonly type: string; readonly attributes?: unknown },
): Record<string, unknown> {
  const attributes = record(event.attributes);
  if (event.type !== "model.requested" || !record(attributes?.call))
    return { ...event };
  return { ...event, digests: modelRequestDigests(attributes) };
}
export function modelRequestDigests(value: unknown) {
  const attributes = record(value) ?? {};
  const call = record(attributes.call) ?? {};
  const configuration = record(attributes.configuration) ?? {};
  return {
    prompt: digest(call.prompt),
    tools: digest({ call: call.tools, contracts: configuration.toolContracts }),
    model: digest(call.model ?? null),
    output: digest(call.outputSchema ?? null),
    configuration: digest(attributes.configuration),
    context: digest(attributes.context),
  };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

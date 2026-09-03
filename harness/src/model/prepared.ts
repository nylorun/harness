import type {
  ModelAdapter,
  ModelAdapterContext,
  ModelCandidate,
  ModelCall,
} from "../types/model.js";
import type { DeferredOutcome, JsonValue } from "../types/shared.js";

export interface PreparedModelOptions<Wire> {
  readonly adapter: string;
  prepare(
    call: ModelCall,
    context: ModelAdapterContext,
  ): Promise<{ readonly request: Wire; readonly observed: JsonValue }>;
  send(request: Wire, call: ModelCall, context: ModelAdapterContext): Promise<unknown>;
  decode(response: unknown, call: ModelCall): ModelCandidate | string | DeferredOutcome;
}

/**
 * Builds a ModelAdapter that reports the provider request derived from Harness's canonical call.
 * The observed value is deliberately JSON-only; opaque wire data remains adapter-local.
 */
export function preparedModel<Wire>(options: PreparedModelOptions<Wire>): ModelAdapter {
  return async (call, context) => {
    const prepared = await options.prepare(call, context);
    context.reportPreparedCall({ adapter: options.adapter, call: prepared.observed });
    return options.decode(await options.send(prepared.request, call, context), call);
  };
}

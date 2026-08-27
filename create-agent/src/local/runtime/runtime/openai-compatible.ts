import { PiModelGatewayAdapter, type PiModelGatewayAdapterOptions } from "./pi-model-gateway.js";

export type { RetryPolicy } from "./pi-model-gateway.js";

/**
 * @deprecated Use `RuntimeOptions.modelGatewayAdapter` for a custom connection. This compatibility
 * facade remains for one release, but its Chat Completions transport is Pi AI rather than Nylo's
 * former HTTP/SSE parser.
 */
export type OpenAICompatibleModelGatewayAdapterOptions = Omit<PiModelGatewayAdapterOptions, "protocol">;

/** @deprecated See `OpenAICompatibleModelGatewayAdapterOptions`. */
export class OpenAICompatibleModelGatewayAdapter extends PiModelGatewayAdapter {
  constructor(options: OpenAICompatibleModelGatewayAdapterOptions) {
    super({ ...options, protocol: "openai-chat-completions" });
  }
}

import {
  anthropicAdapter,
  chatCompletionsAdapter,
  fromChatCompletions,
  fromMessages,
  fromResponses,
  responsesAdapter,
  toChatCompletions,
  toMessages,
  toResponses,
  type ChatCompletionsRequest,
  type MessagesRequest,
  type ResponsesRequest,
} from "@nylorun/harness/model/adapters";
import type { ModelCall } from "../../src/index.js";

declare const call: ModelCall;
const chat: ChatCompletionsRequest = toChatCompletions(call);
const responses: ResponsesRequest = toResponses(call);
const messages: MessagesRequest = toMessages(call, 512);
void [chat, responses, messages];

chatCompletionsAdapter(async () => ({ choices: [{ message: { content: "ok" } }] }));
responsesAdapter(async () => ({ status: "completed", output: [] }));
anthropicAdapter({ defaultMaxOutputTokens: 512, send: async () => ({ content: [] }) });
void [
  fromChatCompletions({ choices: [{ message: {} }] }),
  fromResponses({ output: [] }),
  fromMessages({ content: [] }),
];

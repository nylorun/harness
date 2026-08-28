import { z } from "zod";
import {
  Agent,
  HarnessError,
  type HarnessErrorCode,
  adapter,
  tool,
  type BuiltAgent,
  type BoundToolSchema,
  type BuildDiagnostic,
  type ModelAdapter,
  type ModelCall,
  type ModelCandidate,
  type ModelDirective,
  type ModelRequest,
  type PromptPrefixSnapshot,
  type Session,
  type SessionInput,
  type SessionOptions,
  type StepRequest,
  type StepResponse,
} from "../../src/index.js";
// @ts-expect-error bindAgent is not a public export
import { bindAgent } from "../../src/index.js";

tool({
  name: "echo",
  parameters: z.object({ text: z.string().trim() }),
  executeWith: "local",
});

tool({
  name: "invalid-root",
  // @ts-expect-error Harness accepts Zod object roots only.
  parameters: z.string(),
  executeWith: "local",
});

const local = adapter({
  id: "local",
  async execute(call) {
    return { kind: "completed" as const, output: call.args };
  },
});

Agent(async () => "done")
  .with(local)
  .use("echo", async (_request, next) => next())
  .build()
  .run();

Agent(async () => "done", { id: "opus" });

// @ts-expect-error model is required
Agent();

// @ts-expect-error Agent takes a model adapter function, not an invoker object
Agent({ invoke: async () => "done" });

// @ts-expect-error Agent takes a model adapter function, not a create-options bag
Agent({ model: { invoke: async () => "done" } });

// @ts-expect-error run belongs on BuiltAgent, not the builder
Agent(async () => "done").run();

// @ts-expect-error Agent is a factory, not a constructable class
new Agent(async () => "done");

declare const session: Session;
session.interrupt("ok");
session.interrupt({ text: "ok" });
// @ts-expect-error input() does not accept interrupt
session.input({ kind: "interrupt", text: "x" });

declare const agent: BuiltAgent;

// @ts-expect-error Session limits are application middleware policy.
agent.run({ limits: { maxTurns: 1 } });

// @ts-expect-error run is a Session factory; submit work through session.input
agent.run("hello");

// @ts-expect-error SessionOptions.model was removed
const sessionOptions: SessionOptions = { model: "opus" };

declare const request: StepRequest;
request.context.set("note", [{ type: "note", value: 1 }], { lifetime: "step" });
request.context.remove("note");
// @ts-expect-error context.add was replaced by context.set
request.context.add({ value: 1 });
const sessionId: string = request.sessionId;
void sessionId;
// @ts-expect-error sessionId is immutable
request.sessionId = "other-session";
// @ts-expect-error selectModel was replaced by request.model.select
request.selectModel("opus");
// @ts-expect-error Tool visibility is controlled by the contributing middleware slot.
request.prefix.tools.withhold("echo");
// @ts-expect-error Tool visibility is controlled by the contributing middleware slot.
request.prefix.tools.restore("echo");

declare const prefix: PromptPrefixSnapshot;
// @ts-expect-error Prompt prefixes no longer expose globally withheld tools.
prefix.withheldTools;

const candidate: ModelCandidate = {
  output: [{ type: "text", text: "ok" }],
  finishReason: "stop",
};
// @ts-expect-error content was replaced by output blocks
const oldContent: ModelCandidate = { content: "hi" };
// @ts-expect-error toolCalls was replaced by output blocks
const oldCalls: ModelCandidate = { toolCalls: [] };
// @ts-expect-error metadata was removed
const oldMetadata: ModelCandidate = { output: [], metadata: {} };
// @ts-expect-error error is not a successful finishReason
const failed: ModelCandidate = { output: [], finishReason: "error" };

declare const call: ModelCall;
const prompt = call.prompt;
const callSessionId: string = call.sessionId;
void prompt;
void callSessionId;
// @ts-expect-error system was replaced by prompt
call.system = "";
// @ts-expect-error messages were replaced by prompt
call.messages = [];
// @ts-expect-error turnId is not on ModelCall
call.turnId = "turn";
// @ts-expect-error stepId is not on ModelCall
call.stepId = "step";

declare const modelRequest: ModelRequest;
declare const invoke: ModelAdapter;
void invoke(call, { request: modelRequest, signal: new AbortController().signal });
// @ts-expect-error ModelAdapter receives the projected call before its context object
void invoke(call, modelRequest, new AbortController().signal);

declare const sessionInput: SessionInput;
void sessionInput;

declare const inputHandle: import("../../src/index.js").InputHandle;
// @ts-expect-error completed replaced the redundant consume alias
void inputHandle.consume();

declare const response: StepResponse;
const tripped: StepResponse = response.tripwire({ code: "policy.block", message: "Blocked" });
void tripped;

const harnessCode: HarnessErrorCode = "prefix.duplicate-tool-name";
const harnessError = new HarnessError(harnessCode, "Duplicate tool");
void harnessError;

declare const boundSchema: BoundToolSchema<{ text: string }>;
void boundSchema.validate({ text: "ok" });

const obsoleteDiagnostic: BuildDiagnostic = {
  code: "build.invalid",
  message: "Invalid",
  // @ts-expect-error diagnostics no longer identify capabilities
  capabilityId: "removed",
};
void obsoleteDiagnostic;

const directive: ModelDirective = {
  id: "opus",
  controls: { temperature: 0.2, maxOutputTokens: 128 },
};
// @ts-expect-error extra directive keys are not allowed
const extra: ModelDirective = { id: "opus", extra: true };

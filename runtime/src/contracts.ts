/** Execution contracts are owned by Harness. */
export type {
  JsonValue,
  JsonObject,
  MessageInput,
  UserContentPart,
  PromptContentPart,
  PromptItem,
  ModelCall as RuntimeModelCall,
  ModelCandidate as RuntimeModelCandidate,
  ModelAdapter as RuntimeModelAdapter,
  ModelAdapterContext as RuntimeModelContext,
  ExecutionInput as RuntimeInput,
  InputEvent as RuntimeInputEvent,
  RunResult as RuntimeCompletion,
  ExecutionEvent as RuntimeEvent,
} from "@nylorun/harness";
export type RuntimeAgent = import("@nylorun/harness").BuiltAgent<any, any>;

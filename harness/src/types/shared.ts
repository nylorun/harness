export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface BuildDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly capabilityId?: string;
  readonly toolName?: string;
  readonly cause?: unknown;
}

export interface ContextItem {
  readonly type?: string;
  readonly value: JsonValue;
}

export interface Tripwire {
  readonly code: string;
  readonly message: string;
  readonly scope?: "step" | "session";
}

export type ObserveEvent =
  | { readonly type: "session.created" }
  | { readonly type: "session.stopped"; readonly attributes?: { readonly reason: string } }
  | {
      readonly type: "input.received";
      readonly attributes: { readonly inputId: string; readonly kind: string };
    }
  | { readonly type: "input.queued"; readonly attributes: { readonly inputId: string } }
  | {
      readonly type: "input.rejected";
      readonly attributes: { readonly inputId: string; readonly reason: string };
    }
  | {
      readonly type: "model.started" | "model.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly attributes?: { readonly requestedModelId?: string };
    }
  | {
      readonly type: "step.catalog";
      readonly turnId: string;
      readonly stepId: string;
      readonly attributes: { readonly names: readonly string[]; readonly digest: string };
    }
  | {
      readonly type: "middleware.entered" | "middleware.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly attributes: { readonly middlewareId: string };
    }
  | {
      readonly type: "middleware.lease-violation";
      readonly turnId: string;
      readonly stepId: string;
      readonly attributes: { readonly middlewareId: string; readonly reason: string };
    }
  | {
      readonly type: "tool.sealed";
      readonly turnId: string;
      readonly stepId: string;
      readonly attributes: { readonly calls: number };
    }
  | {
      readonly type: "adapter.preflight.started" | "adapter.started";
      readonly turnId: string;
      readonly stepId: string;
      readonly adapterId: string;
      readonly attributes: { readonly callId: string; readonly invocationId?: string };
    }
  | {
      readonly type: "adapter.preflight.completed" | "adapter.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly adapterId: string;
      readonly attributes: { readonly callId: string; readonly outcome: string };
    }
  | { readonly type: "turn.completed"; readonly turnId: string; readonly stepId: string }
  | {
      readonly type: "interaction.required";
      readonly turnId: string;
      readonly stepId: string;
      readonly attributes: { readonly interactionId: string; readonly kind: string };
    }
  | {
      readonly type: "tripwire";
      readonly turnId: string;
      readonly stepId?: string;
      readonly attributes: { readonly code: string; readonly scope: string };
    };

export type Observer = (event: ObserveEvent) => void | Promise<void>;

export interface CorrelationIds {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
}

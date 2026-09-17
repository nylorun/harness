export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface DeferredOutcome {
  readonly kind: "deferred";
  readonly token?: JsonValue;
}

export interface BuildDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly toolName?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly cause?: unknown;
}

export interface ContextItem {
  readonly type?: string;
  readonly value: JsonValue;
}

export interface Tripwire {
  readonly code: string;
  readonly message: string;
  readonly scope?: "step" | "execution";
}

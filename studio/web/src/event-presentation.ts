export type CanonicalEvent = Readonly<{
  session: string;
  seq: number;
  ts: string;
  type: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type Activity = Readonly<{
  id: string;
  title: string;
  detail: string;
  state: "running" | "completed" | "failed" | "waiting" | "approved" | "denied";
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function compact(value: unknown): string {
  if (typeof value === "string") return value.length > 140 ? `${value.slice(0, 137)}…` : value;
  try {
    const result = JSON.stringify(value);
    return result.length > 140 ? `${result.slice(0, 137)}…` : result;
  } catch {
    return "Result is not serializable.";
  }
}

export function eventLabel(event: CanonicalEvent): string {
  switch (event.type) {
    case "model.requested": return "Model requested";
    case "model.completed": return "Model completed";
    case "model.deferred": return "Model deferred";
    case "model.call": return "Model response";
    case "tool.started": return "Tool started";
    case "tool.completed": return "Tool completed";
    case "tool.deferred": return "Tool deferred";
    case "interaction.required": return record(record(event.payload).interaction).kind === "response" ? "Response required" : "Approval required";
    case "session.run.started": return "Session input received";
    case "final": return "Final answer";
    case "error": return "Run failed";
    default: return event.type.replaceAll(".", " ");
  }
}

export function eventSummary(event: CanonicalEvent): string {
  const payload = event.payload;
  if (event.type.startsWith("tool.")) {
    const name = text(payload.toolName, "tool");
    if (event.type === "tool.completed") {
      const result = record(payload.attributes);
      if (result.kind === "failed") return `${name}: ${text(result.message, text(payload.code, "failed"))}`;
      return `${name}: ${compact(result.output ?? result.kind ?? payload.outcome)}`;
    }
    return name;
  }
  if (event.type === "interaction.required") return text(record(payload.interaction).prompt, "A response is required before this work can continue.");
  if (event.type === "final") return compact(payload.output);
  if (event.type === "error") return text(payload.message, "The run failed.");
  if (event.type === "model.requested") return text(payload.requestedModelId, "Preparing a model request.");
  if (event.type === "model.completed") return "Candidate received.";
  if (event.type === "session.run.started" && payload.input_kind === "approve") return payload.approved === true ? "Approval granted." : "Approval denied.";
  if (event.type === "session.run.started" && payload.input_kind === "respond") return "Response submitted.";
  if (event.type === "middleware.entered" || event.type === "middleware.completed") return text(payload.middlewareId, "middleware");
  if (event.type === "middleware.lease-violation") return `${text(payload.middlewareId, "middleware")}: ${text(payload.reason, "lease violated")}`;
  return "Canonical agent event.";
}

export function activitiesForEvents(events: readonly CanonicalEvent[]): readonly Activity[] {
  return events.flatMap((event) => {
    const activity = (title: string, state: Activity["state"]): readonly Activity[] => [{
      id: `${event.seq}-${event.type}`,
      title,
      detail: eventSummary(event),
      state,
    }];
    switch (event.type) {
      case "model.requested": return activity("Calling model", "running");
      case "model.completed": return activity("Model response received", "completed");
      case "tool.started": return activity(`Running ${text(event.payload.toolName, "tool")}`, "running");
      case "tool.completed": return activity(`${text(event.payload.toolName, "Tool")} ${text(event.payload.outcome, "completed")}`, event.payload.outcome === "failed" ? "failed" : "completed");
      case "interaction.required": return activity(record(event.payload.interaction).kind === "response" ? "Waiting for a response" : "Waiting for approval", "waiting");
      case "session.run.started":
        return event.payload.input_kind === "approve"
          ? activity(event.payload.approved === true ? "Approval granted" : "Approval denied", event.payload.approved === true ? "approved" : "denied")
          : event.payload.input_kind === "respond"
            ? activity("Response submitted", "completed")
            : [];
      case "error": return activity("Run failed", "failed");
      case "final": return activity("Final answer ready", "completed");
      default: return [];
    }
  }).slice(-8);
}

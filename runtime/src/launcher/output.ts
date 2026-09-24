import { LauncherError, UsageError } from "./errors.js";
import type { LauncherEvent } from "./protocol.js";

export interface OutputSink {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  json: boolean;
}

export function emitEvent(sink: OutputSink, event: LauncherEvent): void {
  if (sink.json) {
    sink.stdout(JSON.stringify(event));
    return;
  }
  switch (event.type) {
    case "progress": {
      const parts = [event.phase];
      if (event.message) parts.push(event.message);
      if (event.received !== undefined) {
        parts.push(
          event.total !== undefined
            ? `${event.received}/${event.total}`
            : String(event.received),
        );
      }
      sink.stderr(parts.join(" "));
      return;
    }
    case "result": {
      sink.stdout(JSON.stringify(event, null, 2));
      return;
    }
    case "error": {
      sink.stderr(`${event.message}\n${event.remedy}`);
      return;
    }
    case "log": {
      if (event.source === "tenant" && event.tenantId) {
        sink.stdout(`[${event.tenantId}] ${event.line}`);
      } else {
        sink.stdout(event.line);
      }
      return;
    }
  }
}

export function emitResult(
  sink: OutputSink,
  fields: Record<string, unknown>,
): void {
  emitEvent(sink, { type: "result", ...fields });
}

export function emitError(
  sink: OutputSink,
  error: LauncherError | UsageError | Error,
): void {
  if (error instanceof LauncherError) {
    emitEvent(sink, {
      type: "error",
      code: error.code,
      message: error.message,
      remedy: error.remedy,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
    return;
  }
  if (error instanceof UsageError) {
    // Usage is exit 2. No ErrorCode fits; print message+remedy on stderr even
    // with --json so we do not mint a fake registry code.
    const text = error.remedy
      ? `${error.message}\n${error.remedy}`
      : error.message;
    sink.stderr(text);
    return;
  }
  emitEvent(sink, {
    type: "error",
    code: "install_failed",
    message: error.message,
    remedy: "Retry the command. If it keeps failing, check runtime.log.",
  });
}

export function exitCodeFor(error: unknown): 1 | 2 {
  if (error instanceof UsageError) return 2;
  return 1;
}

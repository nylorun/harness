import type { Json, SessionEvent, SessionState } from "../session/index.js";
import type { FolderDiagnostic } from "../types.js";
import type { ResolvedModel } from "./model.js";

export type Style = Readonly<{
  dim(value: string): string;
  bold(value: string): string;
  red(value: string): string;
  yellow(value: string): string;
}>;

const PLAIN: Style = { dim: (v) => v, bold: (v) => v, red: (v) => v, yellow: (v) => v };

const COLOR: Style = {
  dim: (v) => `[2m${v}[22m`,
  bold: (v) => `[1m${v}[22m`,
  red: (v) => `[31m${v}[39m`,
  yellow: (v) => `[33m${v}[39m`
};

export function styleFor(isTty: boolean): Style {
  return isTty ? COLOR : PLAIN;
}

function text(payload: Readonly<Record<string, Json>>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function count(payload: Readonly<Record<string, Json>>, key: string): number {
  const value = payload[key];
  return typeof value === "number" ? value : 0;
}

function truncate(value: string, limit = 400): string {
  const trimmed = value.trimEnd();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}… (${trimmed.length} bytes)`;
}

export function renderHeader(
  info: Readonly<{ name: string; model: string; digest: string; resolved?: ResolvedModel }>,
  style: Style
): string {
  const lines = [style.bold(info.name), style.dim(`model    ${info.model}`)];
  if (info.resolved !== undefined) {
    // The variable and where it was found, never the value.
    lines.push(
      style.dim(
        `provider ${info.resolved.route} · ${info.resolved.credential.variable} from ${info.resolved.credential.source}`
      )
    );
  }
  lines.push(style.dim(`build    ${info.digest.slice(0, 12)}`), "");
  return lines.join("\n");
}

export function renderDiagnostic(item: FolderDiagnostic, style: Style): string {
  const paint = item.severity === "error" ? style.red : style.yellow;
  return `${paint(item.severity)} ${item.code} ${item.file}: ${item.message}\n  ${style.dim(item.hint)}`;
}

export type Rendered = Readonly<{ text: string; newline: boolean }>;

/**
 * Projects one canonical event into terminal output, or nothing when the event has no presentation.
 * A projection of the canonical vocabulary, never a second event format.
 *
 * `harness.message` carries a per-chunk `delta`, so assistant text streams as it arrives; those are
 * the only fragments written without a trailing newline.
 */
export function renderEvent(event: SessionEvent, style: Style): Rendered | undefined {
  const payload = event.payload;
  switch (event.type) {
    case "harness.message": {
      const delta = text(payload, "delta");
      return delta === "" ? undefined : { text: delta, newline: false };
    }
    case "model.call": {
      const line = `· model ${count(payload, "tokens_in")}in/${count(payload, "tokens_out")}out ${Math.round(
        count(payload, "latency_ms")
      )}ms`;
      return { text: style.dim(line), newline: true };
    }
    case "tool.call.started":
      return { text: style.dim(`→ ${text(payload, "tool")}`), newline: true };
    case "tool.call": {
      const exit = count(payload, "exit");
      const head = `← ${text(payload, "tool")} exit=${exit} ${Math.round(count(payload, "duration_ms"))}ms`;
      const stdout = text(payload, "stdout");
      const stderr = text(payload, "stderr");
      return {
        text: [
          exit === 0 ? style.dim(head) : style.red(head),
          stdout === "" ? "" : `  ${truncate(stdout)}`,
          stderr === "" ? "" : `  ${style.red(truncate(stderr))}`
        ]
          .filter((line) => line !== "")
          .join("\n"),
        newline: true
      };
    }
    case "skill.invocation":
      return { text: style.dim(`skill ${text(payload, "skill")}`), newline: true };
    case "error":
      return { text: style.red(`error ${text(payload, "code")}: ${text(payload, "message")}`), newline: true };
    default:
      return undefined;
  }
}

export function renderFooter(state: SessionState, style: Style): string {
  const cost = state.costUsd > 0 ? ` · $${state.costUsd.toFixed(4)}` : "";
  return style.dim(
    `${state.exitReason ?? state.status} · ${state.turns} turns · ${state.tokensIn}in/${state.tokensOut}out${cost}`
  );
}

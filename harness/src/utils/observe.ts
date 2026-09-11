import type { ObserveEvent, Observer } from "../types/shared.js";

export type ObserveEmit = (event: ObserveEvent | (() => ObserveEvent)) => void;

export function emitObserve(
  listener: Observer | undefined,
  event: ObserveEvent | (() => ObserveEvent),
): void {
  if (!listener) return;
  const snapshot = Object.freeze({ ...(typeof event === "function" ? event() : event) });
  try {
    const result = listener(snapshot);
    if (result && typeof (result as PromiseLike<void>).then === "function")
      void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Observation is deliberately fail-open.
  }
}

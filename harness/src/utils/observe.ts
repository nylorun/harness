import type { ObserveEvent, Observer } from "../types/shared.js";

export function createEmitter(observer?: Observer): (event: ObserveEvent) => void {
  return (event) => {
    if (!observer) return;
    try {
      const result = observer(Object.freeze({ ...event }));
      if (result && typeof (result as PromiseLike<void>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Observation is deliberately fail-open.
    }
  };
}

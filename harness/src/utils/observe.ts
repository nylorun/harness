import type { ObserveEvent, Observer } from "../types/shared.js";

export type ObserveEmit = (event: ObserveEvent | (() => ObserveEvent)) => void;

export interface ObserverRegistry {
  observe(listener: Observer): () => void;
  emit(event: ObserveEvent | (() => ObserveEvent)): void;
  clear(): void;
}

export function createObserverRegistry(): ObserverRegistry {
  const listeners = new Set<Observer>();

  return {
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      if (listeners.size === 0) return;
      const resolved = typeof event === "function" ? event() : event;
      const snapshot = Object.freeze({ ...resolved });
      for (const listener of [...listeners]) {
        try {
          const result = listener(snapshot);
          if (result && typeof (result as PromiseLike<void>).then === "function") {
            void Promise.resolve(result).catch(() => undefined);
          }
        } catch {
          // Observation is deliberately fail-open.
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

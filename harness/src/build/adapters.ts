import type { AdapterExecutionOptions, ToolAdapter } from "../types/tool.js";
import { HarnessError } from "../errors.js";
import { createFixedMap } from "../utils/maps.js";

export interface BoundAdapterRegistration {
  readonly adapter: ToolAdapter;
  readonly options: AdapterExecutionOptions;
}

export interface AdapterRegistry {
  readonly entries: ReadonlyMap<string, BoundAdapterRegistration>;
  require<T extends ToolAdapter = ToolAdapter>(id: string): T;
  execute<T>(id: string, signal: AbortSignal, task: () => Promise<T>): Promise<T>;
}

export function createAdapterRegistry(
  adapters: readonly (BoundAdapterRegistration | ToolAdapter)[] = [],
): AdapterRegistry {
  const entries = new Map<string, BoundAdapterRegistration>();
  const limiters = new Map<string, FifoLimiter>();
  for (const input of adapters) {
    const entry: BoundAdapterRegistration = isBoundAdapterRegistration(input)
      ? input
      : Object.freeze({ adapter: input, options: Object.freeze({}) });
    entries.set(entry.adapter.id, entry);
    if (entry.options.maxConcurrentCalls !== undefined)
      limiters.set(entry.adapter.id, new FifoLimiter(entry.options.maxConcurrentCalls));
  }
  return Object.freeze({
    entries: createFixedMap(entries),
    require<T extends ToolAdapter = ToolAdapter>(id: string): T {
      const entry = entries.get(id);
      if (!entry)
        throw new HarnessError("adapter.not-registered", `Tool adapter '${id}' is not registered`, {
          details: { adapterId: id },
        });
      return entry.adapter as T;
    },
    async execute<T>(id: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
      const limiter = limiters.get(id);
      if (!limiter) return task();
      const release = await limiter.acquire(signal);
      try {
        return await task();
      } finally {
        release();
      }
    },
  });
}

function isBoundAdapterRegistration(
  value: BoundAdapterRegistration | ToolAdapter,
): value is BoundAdapterRegistration {
  return "adapter" in value && "options" in value;
}

class FifoLimiter {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limit && this.waiting.length === 0) {
      this.active += 1;
      return Promise.resolve(this.release);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => resolve(this.release),
        reject,
        signal,
        abort: () => {
          this.remove(waiter);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private readonly release = (): void => {
    this.active -= 1;
    this.drain();
  };

  private drain(): void {
    while (this.active < this.limit && this.waiting.length) {
      const waiter = this.waiting.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      this.active += 1;
      waiter.resolve();
    }
  }

  private remove(waiter: Waiter): void {
    const index = this.waiting.indexOf(waiter);
    if (index !== -1) this.waiting.splice(index, 1);
    waiter.signal.removeEventListener("abort", waiter.abort);
  }
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

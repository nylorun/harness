/** Run async work over items with a fixed concurrency limit. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

export class TimeoutError extends Error {
  constructor(message = "operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a timeout. On timeout the late result is handed to
 * `onLate` (Risk R6: mark quarantined and close a late handle).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onLate?: (late: Promise<T>) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new TimeoutError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    return result;
  } catch (error) {
    if (timedOut && onLate) {
      onLate(
        promise.then(
          (value) => value,
          (lateError) => {
            throw lateError;
          },
        ),
      );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

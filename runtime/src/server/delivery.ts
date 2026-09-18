/** Bounded per-request delivery. Generation never waits for a subscriber. */
export class EventDelivery {
  readonly response: Response;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly queue: { bytes: Uint8Array; preview?: string }[] = [];
  private readonly suppressed = new Set<string>();
  private previewBytes = 0;
  private readonly previewTotals = new Map<string, number>();
  private eventBytes = 0;
  private eventCount = 0;
  private ended = false;
  private closed = false;
  constructor(
    private readonly abort: () => void,
    private readonly limits: {
      previewBytes?: number;
      eventBytes?: number;
      eventCount?: number;
    } = {},
    inherited?: HeadersInit,
  ) {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value! <= 0)
        throw new Error("Delivery limits must be positive integers");
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: () => this.flush(),
        cancel: () => {
          this.closed = true;
          this.queue.length = 0;
          abort();
        },
      },
      { highWaterMark: 0 },
    );
    const headers = new Headers(inherited);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    headers.set("cache-control", "no-cache");
    this.response = new Response(stream, { headers });
  }
  private waiting = false;
  private flush() {
    if (this.closed) return;
    const item = this.queue.shift();
    if (item) {
      this.waiting = false;
      if (item.preview) this.previewBytes -= item.bytes.byteLength;
      else {
        this.eventBytes -= item.bytes.byteLength;
        this.eventCount--;
      }
      this.controller.enqueue(item.bytes);
    } else if (this.ended) {
      this.closed = true;
      this.controller.close();
    } else this.waiting = true;
  }
  push(event: Record<string, unknown>, preview?: string): void {
    if (this.closed || this.ended || (preview && this.suppressed.has(preview)))
      return;
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify(event)}\n\n`,
    );
    if (
      preview &&
      Math.max(this.previewBytes, this.previewTotals.get(preview) ?? 0) +
        bytes.byteLength >
        (this.limits.previewBytes ?? 64 * 1024)
    ) {
      this.suppressed.add(preview);
      for (let i = this.queue.length - 1; i >= 0; i--)
        if (this.queue[i]!.preview === preview) {
          this.previewBytes -= this.queue[i]!.bytes.byteLength;
          this.queue.splice(i, 1);
        }
      this.push({
        type: "CUSTOM",
        name: "nylorun.preview.incomplete",
        value: { invocationId: preview },
      });
      return;
    }
    if (
      !preview &&
      (this.eventCount + 1 > (this.limits.eventCount ?? 256) ||
        this.eventBytes + bytes.byteLength >
          (this.limits.eventBytes ?? 1024 * 1024))
    ) {
      this.closed = true;
      this.queue.length = 0;
      this.controller.error(
        new Error("Subscriber exceeded execution-event delivery limits"),
      );
      this.abort();
      return;
    }
    this.queue.push({ bytes, ...(preview ? { preview } : {}) });
    if (preview) {
      this.previewBytes += bytes.byteLength;
      this.previewTotals.set(
        preview,
        (this.previewTotals.get(preview) ?? 0) + bytes.byteLength,
      );
    } else {
      this.eventBytes += bytes.byteLength;
      this.eventCount++;
    }
    if (this.waiting) this.flush();
  }
  end(): void {
    this.ended = true;
    if (this.waiting) this.flush();
  }
}

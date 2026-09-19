/**
 * Minimal SSE parser for Agents API event streams.
 * Yields JSON payloads from `data:` lines (ignores comments / unnamed fields).
 */

export async function* parseSseJsonStream(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const dataLines: string[] = [];
        for (const line of chunk.split(/\r?\n/)) {
          if (!line || line.startsWith(":")) continue;
          if (line.startsWith("data:"))
            dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!dataLines.length) continue;
        const raw = dataLines.join("\n");
        if (raw === "[DONE]") return;
        try {
          yield JSON.parse(raw) as unknown;
        } catch {
          // Non-JSON data frames are ignored (heartbeats / unfrozen shapes).
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

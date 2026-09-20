export interface Destination {
  url?: string;
  key?: string;
  fetch?: typeof fetch;
}
export function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}
export class RuntimeError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Runtime HTTP ${status}: ${JSON.stringify(body)}`);
  }
}
export class Transport {
  readonly url: string;
  readonly key: string;
  readonly fetcher: typeof fetch;
  constructor(
    options: Destination = {},
    role: "server" | "executor" = "server"
  ) {
    const url = options.url ?? env("NYLORUN_RUNTIME_URL");
    const key =
      options.key ??
      env(role === "server" ? "NYLORUN_SERVER_KEY" : "NYLORUN_EXECUTOR_KEY");
    if (!url || !key)
      throw new Error(
        `Set Runtime url and ${role} key explicitly or via NYLORUN_RUNTIME_URL / NYLORUN_${role.toUpperCase()}_KEY`
      );
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("Runtime requires an HTTP(S) URL");
    this.url = url.replace(/\/$/, "");
    this.key = key;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.key}`);
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await this.fetcher(this.url + path, {
      ...init,
      headers,
      redirect: "error",
    });
    if (!response.ok) {
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      throw new RuntimeError(response.status, body);
    }
    return response;
  }
  async json<T>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await this.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    return response.status === 204
      ? (undefined as T)
      : (response.json() as Promise<T>);
  }
}
export const id = () => globalThis.crypto.randomUUID();
export const segment = (value: string) => encodeURIComponent(value);
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

export type BrowserStudioConfig = Readonly<{ agentServerUrl?: string }>;

export function parseBrowserStudioConfig(value: unknown, studioProtocol: string): BrowserStudioConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("nylo-studio.config.json must contain an object.");
  const candidate = (value as Record<string, unknown>).agentServerUrl;
  if (candidate === undefined) return Object.freeze({});
  if (typeof candidate !== "string") throw new Error("agentServerUrl must be a string.");
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error("agentServerUrl must be an absolute http(s) URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("agentServerUrl must use http or https.");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("agentServerUrl must not contain credentials, a query string, or a fragment.");
  if (studioProtocol === "https:" && url.protocol === "http:") throw new Error("An HTTPS Studio cannot connect to an HTTP Agent Server. Serve the Agent Server over HTTPS.");
  return Object.freeze({ agentServerUrl: url.href.replace(/\/$/u, "") });
}

export async function loadBrowserStudioConfig(fetcher: typeof fetch = fetch, documentUrl: string = document.baseURI): Promise<BrowserStudioConfig> {
  const studioUrl = new URL(documentUrl);
  // BrowserRouter owns client paths such as /session/:id. Configuration belongs to the static
  // host root, not the current SPA route, or a fallback HTML response would look like an outage.
  const response = await fetcher(new URL("/nylo-studio.config.json", studioUrl.origin));
  if (!response.ok) throw new Error(`Could not load nylo-studio.config.json (${response.status}).`);
  return parseBrowserStudioConfig(await response.json(), new URL(documentUrl).protocol);
}

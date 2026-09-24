export type StudioTenantInfo = Readonly<{ id: string; name: string }>;

export type BrowserStudioConfig = Readonly<{
  agentServerUrl?: string;
  tenant?: StudioTenantInfo;
}>;

export function shortTenantId(id: string): string {
  if (id.length <= 11) return id;
  return `${id.slice(0, 3)}…${id.slice(-8)}`;
}

export function parseBrowserStudioConfig(
  value: unknown,
  studioProtocol: string,
): BrowserStudioConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("nylo-studio.config.json must contain an object.");
  const record = value as Record<string, unknown>;
  const result: { agentServerUrl?: string; tenant?: StudioTenantInfo } = {};
  const candidate = record.agentServerUrl ?? record.runtimeUrl;
  if (candidate !== undefined) {
    if (typeof candidate !== "string")
      throw new Error("agentServerUrl must be a string.");
    // Relative proxy paths such as /_studio/runtime are intentional for the
    // trusted local Studio host; absolute URLs are validated as before.
    if (candidate.startsWith("/")) {
      result.agentServerUrl = candidate.replace(/\/$/u, "") || "/";
    } else {
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        throw new Error("agentServerUrl must be an absolute http(s) URL.");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("agentServerUrl must use http or https.");
      if (
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
      )
        throw new Error(
          "agentServerUrl must not contain credentials, a query string, or a fragment.",
        );
      if (studioProtocol === "https:" && url.protocol === "http:")
        throw new Error(
          "An HTTPS Studio cannot connect to an HTTP Agent Server. Serve the Agent Server over HTTPS.",
        );
      result.agentServerUrl = url.href.replace(/\/$/u, "");
    }
  }
  const tenant = record.tenant;
  if (tenant !== undefined) {
    if (typeof tenant !== "object" || tenant === null || Array.isArray(tenant))
      throw new Error("tenant must be an object with id and name.");
    const id = (tenant as Record<string, unknown>).id;
    const name = (tenant as Record<string, unknown>).name;
    if (typeof id !== "string" || id.length === 0)
      throw new Error("tenant.id must be a non-empty string.");
    if (typeof name !== "string" || name.length === 0)
      throw new Error("tenant.name must be a non-empty string.");
    result.tenant = Object.freeze({ id, name });
  }
  return Object.freeze(result);
}

export async function loadBrowserStudioConfig(
  fetcher: typeof fetch = fetch,
  documentUrl: string = document.baseURI,
): Promise<BrowserStudioConfig> {
  const studioUrl = new URL(documentUrl);
  // BrowserRouter owns client paths such as /session/:id. Configuration belongs to the static
  // host root, not the current SPA route, or a fallback HTML response would look like an outage.
  const response = await fetcher(
    new URL("/nylo-studio.config.json", studioUrl.origin),
  );
  if (!response.ok)
    throw new Error(
      `Could not load nylo-studio.config.json (${response.status}).`,
    );
  return parseBrowserStudioConfig(
    await response.json(),
    new URL(documentUrl).protocol,
  );
}

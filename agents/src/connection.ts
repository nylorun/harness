export interface ResolvedConnection {
  url: string;
  tenant: string;
  key: string;
  role: "application" | "executor";
  source: "options" | "environment" | "project-link";
}

/** Wave 0 signature only; WS-C implements resolution (D§7.1). */
export async function resolveConnection(options?: {
  url?: string;
  tenant?: string;
  key?: string;
  cwd?: string;
}): Promise<ResolvedConnection> {
  void options;
  throw new Error("not implemented");
}

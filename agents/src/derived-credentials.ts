import { createHmac } from "node:crypto";

/**
 * Deterministic executor token from an application key (D§7.3).
 * Same key, Tenant and agent always produce the same token.
 */
export function deriveExecutorToken(
  applicationKey: string,
  tenantId: string,
  agentId: string,
): string {
  const message = Buffer.concat([
    Buffer.from("nylorun/executor/v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(tenantId, "utf8"),
    Buffer.from([0]),
    Buffer.from(agentId, "utf8"),
  ]);
  return createHmac("sha256", Buffer.from(applicationKey, "utf8"))
    .update(message)
    .digest("hex");
}

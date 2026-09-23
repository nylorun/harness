import { createHash, timingSafeEqual } from "node:crypto";
import type { ExecutorScope } from "@nylorun/core/contracts";

const equals = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

/**
 * Executor bearer tokens are 256-bit CSPRNG values minted by the CLI and the wire schema
 * requires at least 16 characters, so an unsalted digest is adequate to keep them out of
 * SQLite at rest. This is not a password KDF and must not be used for one.
 */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export interface ExecutorRecord extends ExecutorScope {
  readonly tokenHash: string;
  /** False for scopes supplied through NYLORUN_EXECUTORS_JSON, which are never written to SQLite. */
  readonly persisted: boolean;
  readonly updatedAt: string;
}

export function assertExecutorCredential(
  executor: {
    agentId: string;
    implementationVersion: string;
    token: string;
  },
  serverToken: string
): void {
  if (
    executor.token.length < 16 ||
    equals(executor.token, serverToken) ||
    !executor.agentId ||
    !executor.implementationVersion
  )
    throw new Error(
      "Executor tokens require independent credentials and an agent id"
    );
}

export class ExecutorRegistry {
  private readonly byHash = new Map<string, ExecutorRecord>();
  private readonly byAgent = new Map<string, ExecutorRecord>();
  seed(records: readonly ExecutorRecord[]): void {
    for (const record of records) this.write(record);
  }
  find(tokenHash: string): ExecutorRecord | undefined {
    return this.byHash.get(tokenHash);
  }
  get(agentId: string): ExecutorRecord | undefined {
    return this.byAgent.get(agentId);
  }
  list(): readonly ExecutorRecord[] {
    return [...this.byAgent.values()];
  }
  upsert(record: ExecutorRecord): {
    rotated: boolean;
    previousHash?: string;
  } {
    const previous = this.byAgent.get(record.agentId);
    const collision = this.byHash.get(record.tokenHash);
    if (collision && collision.agentId !== record.agentId)
      throw new Error("Executor tokens must be unique");
    this.write(record);
    if (!previous || previous.tokenHash === record.tokenHash)
      return { rotated: false };
    return { rotated: true, previousHash: previous.tokenHash };
  }
  remove(agentId: string): ExecutorRecord | undefined {
    const record = this.byAgent.get(agentId);
    if (!record) return undefined;
    this.byAgent.delete(agentId);
    this.byHash.delete(record.tokenHash);
    return record;
  }
  private write(record: ExecutorRecord): void {
    const previous = this.byAgent.get(record.agentId);
    if (previous) this.byHash.delete(previous.tokenHash);
    this.byAgent.set(record.agentId, record);
    this.byHash.set(record.tokenHash, record);
  }
}

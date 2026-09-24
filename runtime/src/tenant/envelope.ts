import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TenantEnvelopeSchema,
  type TenantEnvelope,
} from "@nylorun/core/contracts";
import { quarantine } from "./quarantine.js";

export function parseEnvelope(
  raw: unknown,
  expectedId?: string,
): TenantEnvelope {
  const parsed = TenantEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw quarantine(
      "envelope-invalid",
      "tenant.json is missing or not a valid Tenant envelope",
      expectedId ? { tenantId: expectedId } : {},
    );
  }
  if (expectedId !== undefined && parsed.data.id !== expectedId) {
    throw quarantine(
      "envelope-invalid",
      `tenant.json id ${parsed.data.id} does not match directory ${expectedId}`,
      { tenantId: expectedId },
    );
  }
  return parsed.data;
}

export function readEnvelopeFile(
  path: string,
  expectedId?: string,
): TenantEnvelope {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw quarantine(
        "envelope-invalid",
        "tenant.json is missing",
        expectedId ? { tenantId: expectedId } : {},
      );
    }
    throw quarantine(
      "corrupt",
      "tenant.json could not be read",
      expectedId ? { tenantId: expectedId } : {},
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw quarantine(
      "envelope-invalid",
      "tenant.json is not valid JSON",
      expectedId ? { tenantId: expectedId } : {},
    );
  }
  return parseEnvelope(json, expectedId);
}

/** Write envelope via temp sibling then rename (atomic on the same filesystem). */
export function writeEnvelopeFile(
  envelopePath: string,
  envelope: TenantEnvelope,
): void {
  const validated = parseEnvelope(envelope, envelope.id);
  const tmp = join(
    envelopePath + `.tmp-${process.pid}-${Date.now()}`,
  );
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, envelopePath);
}

export function envelopeNow(
  input: { id: string; name: string; schemaVersion: number },
  now = new Date(),
): TenantEnvelope {
  const iso = now.toISOString();
  return {
    id: input.id,
    name: input.name,
    createdAt: iso,
    updatedAt: iso,
    schemaVersion: input.schemaVersion,
  };
}

import {
  checkCompatibility,
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  type ProtocolRange,
} from "@nylorun/agents";
import { CliError } from "../errors.js";
import { probeHostHealth } from "./root.js";

export interface CompatibilityReport {
  ok: true;
  protocol: ProtocolRange;
  version?: string;
  hostId?: string;
}

/**
 * Fetch `/health`, run `checkCompatibility`, and throw with the exact upgrade
 * or downgrade remedy when the Host is out of range or missing features.
 */
export async function assertHostCompatible(
  url: string,
  options: {
    clientVersion?: number;
    required?: readonly string[];
  } = {},
): Promise<CompatibilityReport> {
  const probe = await probeHostHealth(url);
  if (!probe.health) {
    throw new CliError(
      `No Runtime Host is answering at ${url}. Start one with "nylorun runtime up".`,
      6,
    );
  }
  const protocol = probe.health.protocol;
  if (!protocol) {
    throw new CliError(
      `The Runtime Host at ${url} does not advertise a protocol range. Upgrade the Host with "nylorun runtime restart" from a newer CLI, or install a compatible CLI with "npm i -D @nylorun/cli@${cliRangeFor(HOST_PROTOCOL)}".`,
      5,
    );
  }
  const client = {
    version: options.clientVersion ?? PROTOCOL_VERSION,
    required: options.required ?? [...PROTOCOL_FEATURES],
  };
  const result = checkCompatibility(client, protocol);
  if (result.ok) {
    return {
      ok: true,
      protocol,
      ...(probe.health.version ? { version: probe.health.version } : {}),
      ...(probe.health.hostId ? { hostId: probe.health.hostId } : {}),
    };
  }
  if (result.reason === "version") {
    const remedy = remedyForVersion(client.version, result.host);
    throw new CliError(
      `Protocol ${client.version} is outside the Host range ${result.host.min}–${result.host.max} at ${url}. ${remedy}`,
      5,
    );
  }
  const missing = result.missing.join(", ");
  throw new CliError(
    `The Runtime Host at ${url} is missing required feature(s): ${missing}. Upgrade the Host with "nylorun runtime restart" from a newer CLI, or install a compatible CLI with "npm i -D @nylorun/cli@${cliRangeFor(result.host)}".`,
    5,
  );
}

export function warnHostIncompatible(url: string): Promise<void> {
  return assertHostCompatible(url).then(
    () => undefined,
    (error: unknown) => {
      console.warn(error instanceof Error ? error.message : String(error));
    },
  );
}

function remedyForVersion(client: number, host: ProtocolRange): string {
  if (client < host.min) {
    return `Upgrade the Host with "nylorun runtime restart" from a newer CLI.`;
  }
  return `Install a compatible CLI with "npm i -D @nylorun/cli@${cliRangeFor(host)}".`;
}

/** Coarse npm range hint from the Host's advertised protocol max. */
export function cliRangeFor(host: ProtocolRange): string {
  // Protocol 2 ships with the Runtime Tenants CLI line; keep the hint concrete.
  if (host.max <= 1) return "<0.3.0-beta";
  return `>=0.3.0-beta`;
}

export { PROTOCOL_VERSION, PROTOCOL_FEATURES, HOST_PROTOCOL, checkCompatibility };

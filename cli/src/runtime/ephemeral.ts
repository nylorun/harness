import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdmin as defaultCreateAdmin } from "@nylorun/admin";
import type { Admin } from "@nylorun/admin";
import { CliError } from "../errors.js";
import {
  launcher,
  throwOnLauncherFailure,
  type LauncherHandle,
  type LauncherOptions,
} from "./launcher.js";

export interface EphemeralOptions extends LauncherOptions {
  /** Temporary Host root. Default: a new directory under os.tmpdir(). */
  home?: string;
  /** Tenant display name. Default: directory basename or "ephemeral". */
  name?: string;
  /** Injected Admin factory (tests). Default: `@nylorun/admin` createAdmin. */
  createAdmin?: typeof defaultCreateAdmin;
  /** Abort / cleanup signal (tests and SIGINT wiring). */
  signal?: AbortSignal;
}

export interface EphemeralTenant {
  id: string;
  name: string;
}

export interface EphemeralRuntime {
  home: string;
  url: string;
  hostId: string;
  version: string;
  tenant: EphemeralTenant;
  applicationKey: string;
  admin: Admin;
  /** Stop the Host and delete the temporary home. */
  close(): Promise<void>;
}

/**
 * `nylorun dev --ephemeral` Host setup (D§12):
 * temporary home, start Host on port 0, `createAdmin({ home })`, `createTenant`.
 *
 * Uses launcher `up --port 0` (detached Host) rather than foreground `run`, so
 * the CLI can continue with Project setup / tsx watch and still `down` on exit.
 * Semantically matches D§12: temporary home, free port, createTenant, cleanup.
 */
export async function startEphemeral(
  options: EphemeralOptions = {},
): Promise<EphemeralRuntime> {
  const home =
    options.home ??
    (await mkdtemp(join(tmpdir(), "nylorun-ephemeral-")));
  const createAdminFn = options.createAdmin ?? defaultCreateAdmin;
  const env = options.env ?? process.env;

  const handle: LauncherHandle = await launcher(home, { env });

  const up = await handle.invoke(["up", "--port", "0"], { env });
  throwOnLauncherFailure(up);
  const result = up.result ?? {};
  const url = typeof result.url === "string" ? result.url : undefined;
  if (!url) {
    throw new CliError(
      `Ephemeral Runtime Host started without a URL under ${home}.`,
      7,
    );
  }
  const ready = {
    url,
    hostId:
      typeof result.hostId === "string" ? result.hostId : "host_unknown",
    version:
      typeof result.version === "string"
        ? result.version
        : handle.runtime.version,
  };

  const admin = createAdminFn({ home });
  const name =
    options.name ??
    home.split(/[/\\]/).filter(Boolean).pop() ??
    "ephemeral";
  const created = await admin.createTenant({ name });
  const tenant: EphemeralTenant = {
    id: created.tenant.id,
    name: created.tenant.name ?? name,
  };

  let closed = false;
  let closing: Promise<void> | undefined;
  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      if (closed) return;
      closed = true;
      try {
        const down = await handle.invoke(["down", "--force"], { env });
        if (down.exitCode !== 0) throwOnLauncherFailure(down);
      } catch {
        /* best-effort stop */
      }
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    })();
    return closing;
  };

  if (options.signal) {
    const onAbort = () => {
      void close();
    };
    if (options.signal.aborted) void close();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    home,
    url: ready.url,
    hostId: ready.hostId,
    version: ready.version,
    tenant,
    applicationKey: created.applicationKey,
    admin,
    close,
  };
}

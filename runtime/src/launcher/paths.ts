import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Layout under the Host root (matches design D§3.6). */
export interface HostPaths {
  root: string;
  config: string;
  state: string;
  credentials: string;
  log: string;
  home: string;
  tmp: string;
  tenants: string;
  trash: string;
  lifecycleLock: string;
}

export function hostPaths(hostRoot: string): HostPaths {
  const root = resolve(hostRoot);
  return {
    root,
    config: join(root, "host.json"),
    state: join(root, "host-state.json"),
    credentials: join(root, "host-credentials.json"),
    log: join(root, "runtime.log"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    tenants: join(root, "tenants"),
    trash: join(root, "trash"),
    lifecycleLock: join(root, ".lifecycle.lock"),
  };
}

export async function ensureHostLayout(paths: HostPaths): Promise<void> {
  for (const dir of [
    paths.root,
    paths.home,
    paths.tmp,
    paths.tenants,
    paths.trash,
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

export function ensureDirSync(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function hostUrl(config: { host: string; port: number }): string {
  return `http://${config.host}:${config.port}`;
}

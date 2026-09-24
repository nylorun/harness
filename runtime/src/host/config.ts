/** host.json — durable, no secrets */
export interface HostConfigFile {
  hostId: string; // "host_" + 26 Crockford chars
  host: string;
  port: number; // loopback by default
  allowNonLoopback?: boolean;
  proxy?: {
    httpsProxy?: string;
    noProxy?: string;
    nodeExtraCaCerts?: string;
  };
}

/** host-state.json — process only */
export interface HostStateFile {
  pid: number;
  startedAt: string;
  version: string;
  entry: string;
  url: string;
}

/** host-credentials.json, mode 0600 */
export interface HostCredentialsFile {
  adminKey: string;
}

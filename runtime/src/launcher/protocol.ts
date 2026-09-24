import type { ErrorCode } from "@nylorun/core/compatibility";

export type LauncherEvent =
  | {
      type: "progress";
      phase:
        | "download"
        | "verify"
        | "extract"
        | "install"
        | "start"
        | "stop"
        | "wait";
      received?: number;
      total?: number;
      message?: string;
    }
  | { type: "result"; [field: string]: unknown }
  | {
      type: "error";
      code: ErrorCode;
      message: string;
      remedy: string;
      details?: unknown;
    }
  | {
      type: "log";
      source: "host" | "tenant";
      tenantId?: string;
      line: string;
    };

export interface UpResult {
  url: string;
  hostId: string;
  pid: number;
  version: string;
  started: boolean;
}

export interface InstallResult {
  version: string;
  path: string;
  installed: boolean;
}

export interface DownResult {
  stopped: boolean;
}

export interface StatusResult {
  launcherProtocol: 1;
  home: string;
  state: "running" | "stopped" | "absent" | "unresponsive" | "foreign-port";
  url?: string;
  hostId?: string;
  pid?: number;
  version?: string;
  runtimeVersion?: string;
  installed: string[];
}

export interface HostConfigFileV1 {
  format: 1;
  hostId: string;
  host: string;
  port: number;
  runtimeVersion?: string;
  allowNonLoopback?: boolean;
  proxy?: {
    httpsProxy?: string;
    noProxy?: string;
    nodeExtraCaCerts?: string;
  };
}

export interface InstallRecord {
  format: 1;
  version: string;
  integrity: string | null;
  source: "registry" | "path";
  installedAt: string;
}

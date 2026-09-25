import type { ErrorCode, ProtocolRange } from "@nylorun/core/compatibility";

export type LauncherEvent =
  | {
      type: "progress";
      phase: "start" | "stop" | "wait";
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
  /** Version of the installed `@nylorun/runtime` running this launcher. */
  launcherVersion: string;
}

/** `nylorun-runtime version`: what is installed and what it speaks. */
export interface VersionResult {
  runtimeVersion: string;
  launcherProtocol: 1;
  protocol: ProtocolRange;
  node: string;
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


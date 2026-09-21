import type { ModelAdapter } from "@nylorun/core/define";
import type { SessionStore } from "./sessions/store.js";
import type { RuntimeMedia } from "./media.js";
import type { ModelEnvironment } from "./model/http-model.js";
import type { CloudConfig } from "./cloud/config.js";

export interface RuntimeConfig {
  readonly onModelCall?: ModelAdapter;
  readonly createModel?: (
    options: import("./model/defaults.js").ModelFactoryOptions,
  ) => ModelAdapter;
  readonly observer?: (event: {
    readonly type: string;
  }) => void | Promise<void>;
  readonly sessions?: SessionStore;
  readonly media?: RuntimeMedia;
  readonly environment?: ModelEnvironment;
  readonly tokens?: boolean;
  readonly delivery?: {
    readonly previewBytes?: number;
    readonly eventBytes?: number;
    readonly eventCount?: number;
  };
  /**
   * Cloud Agents API destination. When set (or resolved from `NYLORUN_URL` /
   * `NYLORUN_CLOUD_URL` + credential, optionally `NYLORUN_MODE=cloud`),
   * `openSession` uses HTTP/SSE instead of the local SessionHost.
   * `NYLORUN_MODE=local` forces local. Local stays the default when URL/key unset.
   */
  readonly cloud?: CloudConfig;
}

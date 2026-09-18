import type { ModelAdapter } from "@nylorun/harness";
import type { SessionStore } from "./sessions/store.js";
import type { RuntimeMedia } from "./media.js";
import type { ModelEnvironment } from "./model/http-model.js";

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
}

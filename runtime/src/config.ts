import type { RuntimeModelAdapter } from "./contracts.js";
import type { RuntimeDurability } from "./adapters/journal.js";
import type { RuntimeMedia } from "./adapters/media.js";

export interface RuntimeConfig {
  readonly onModelCall?: RuntimeModelAdapter;
  readonly observer?: { (event: { readonly type: string }): void | Promise<void> };
  readonly durability?: RuntimeDurability;
  readonly media?: RuntimeMedia;
}

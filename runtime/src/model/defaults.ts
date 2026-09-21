import type { ModelAdapter } from "@nylorun/core/define";
import { httpModel, type ModelEnvironment } from "./http-model.js";

export interface ModelPreview {
  readonly invocationId: string;
  readonly text: string;
}
export interface ModelFactoryOptions {
  readonly environment?: ModelEnvironment;
  readonly media?: import("../media.js").RuntimeMedia;
  readonly onPreview?: (preview: ModelPreview) => void;
}
let nodeFactory: ((options: ModelFactoryOptions) => ModelAdapter) | undefined;
/** Installed only by the Node launcher before application imports. */
export function installNodeModelFactory(
  factory: (options: ModelFactoryOptions) => ModelAdapter,
): void {
  nodeFactory = factory;
}
export function defaultModel(options: ModelFactoryOptions): ModelAdapter {
  return options.environment === undefined && nodeFactory
    ? nodeFactory(options)
    : httpModel(options);
}
export function processEnvironment(): ModelEnvironment {
  return typeof process === "undefined" ? {} : process.env;
}

let runtimeLifecycle: ((close: () => Promise<void>) => void) | undefined;
export function installRuntimeLifecycle(
  register: (close: () => Promise<void>) => void,
): void {
  runtimeLifecycle = register;
}
export function registerRuntimeLifecycle(close: () => Promise<void>): void {
  runtimeLifecycle?.(close);
}

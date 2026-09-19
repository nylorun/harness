import type { Runtime } from "../server/host.js";

let defaultRuntime: Runtime | undefined;
let bannerShown = false;
let createRuntime: (() => Runtime) | undefined;

/** Wired from `server/host.ts` after `Runtime` is defined (avoids init cycles). */
export function installDefaultRuntimeFactory(factory: () => Runtime): void {
  createRuntime = factory;
}

export function setDefaultRuntime(runtime: Runtime | undefined): void {
  defaultRuntime = runtime;
}

export function getDefaultRuntime(): Runtime {
  if (defaultRuntime) return defaultRuntime;
  if (!createRuntime)
    throw new Error("Default Runtime factory is not installed");
  defaultRuntime = createRuntime();
  maybeBanner();
  return defaultRuntime;
}

function maybeBanner(): void {
  if (bannerShown || typeof process === "undefined") return;
  if (process.env.NYLORUN_QUIET === "1") return;
  bannerShown = true;
  const mode = (process.env.NYLORUN_MODE ?? "").toLowerCase();
  if (mode === "cloud") {
    const url =
      process.env.NYLORUN_URL ?? process.env.NYLORUN_CLOUD_URL ?? "unset";
    console.info(
      `nylorun ▸ cloud runtime · Agents API ${url} · loop runs in Nylorun Cloud (proposed wire)`,
    );
    return;
  }
  const model =
    process.env.MODEL_PROVIDER && process.env.MODEL
      ? `${process.env.MODEL_PROVIDER}/${process.env.MODEL}`
      : "unset";
  console.info(
    `nylorun ▸ local runtime · loop runs in this process · sessions in memory · model ${model} (your key)`,
  );
}

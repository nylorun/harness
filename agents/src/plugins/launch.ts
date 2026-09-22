import { mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { McpServerManifest } from "@nylorun/core/define";

const ROOT_TOKEN = "${PLUGIN_ROOT}";
const DATA_TOKEN = "${PLUGIN_DATA}";

/** Single-pass replacement. Text inserted for a token is not scanned again. */
export function expandPluginPlaceholders(
  value: string,
  pluginRoot: string,
  pluginData: string
): string {
  let out = "";
  for (let index = 0; index < value.length; ) {
    if (value.startsWith(ROOT_TOKEN, index)) {
      out += pluginRoot;
      index += ROOT_TOKEN.length;
      continue;
    }
    if (value.startsWith(DATA_TOKEN, index)) {
      out += pluginData;
      index += DATA_TOKEN.length;
      continue;
    }
    out += value[index];
    index += 1;
  }
  return out;
}

export interface StdioLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export function prepareStdioLaunch(
  server: Extract<McpServerManifest, { type: "stdio" }>,
  options: {
    readonly pluginRoot: string;
    readonly pluginData: string;
    readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  }
): StdioLaunch {
  const pluginRoot = options.pluginRoot;
  const pluginData = options.pluginData;
  mkdirSync(pluginData, { recursive: true });
  const command = resolveCommand(server.command, pluginRoot);
  const args = (server.args ?? []).map((arg) =>
    expandPluginPlaceholders(arg, pluginRoot, pluginData)
  );
  const cwd = server.cwd
    ? resolveContainedCwd(server.cwd, pluginRoot, pluginData)
    : pluginRoot;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.baseEnv ?? {})) {
    if (typeof value === "string") setEnv(env, key, value);
  }
  for (const [key, value] of Object.entries(server.env ?? {}))
    setEnv(env, key, expandPluginPlaceholders(value, pluginRoot, pluginData));
  setEnv(env, "PLUGIN_ROOT", pluginRoot);
  setEnv(env, "PLUGIN_DATA", pluginData);
  return { command, args, cwd, env };
}

function resolveCommand(command: string, pluginRoot: string): string {
  if (command.startsWith("./")) return resolve(pluginRoot, command);
  return command;
}

export function resolveContainedCwd(
  cwd: string,
  pluginRoot: string,
  pluginData: string
): string {
  const expanded = expandPluginPlaceholders(cwd, pluginRoot, pluginData);
  const absolute = isAbsolute(expanded) ? expanded : resolve(pluginRoot, expanded);
  const root = cwdTargetsData(cwd) ? pluginData : pluginRoot;
  if (!isInside(root, absolute))
    throw new Error(`Working directory escapes ${root}`);
  return absolute;
}

function cwdTargetsData(cwd: string): boolean {
  return cwd === DATA_TOKEN || cwd.startsWith(`${DATA_TOKEN}/`);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function setEnv(env: Record<string, string>, key: string, value: string): void {
  if (process.platform === "win32") {
    const existing = Object.keys(env).find(
      (name) => name.toLowerCase() === key.toLowerCase()
    );
    if (existing && existing !== key) delete env[existing];
  }
  env[key] = value;
}

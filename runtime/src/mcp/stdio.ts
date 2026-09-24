import { mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { McpServerManifest } from "@nylorun/core/define";

const ROOT_TOKEN = "${PLUGIN_ROOT}";
const DATA_TOKEN = "${PLUGIN_DATA}";

/** Single-pass replacement. Text inserted for a token is not scanned again. */
export function expandPluginPlaceholders(
  value: string,
  pluginRoot: string,
  pluginData: string,
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
    readonly pluginRoot?: string;
    readonly pluginData: string;
    /** Allowlisted base env (Tenant HOME/TMPDIR/PATH). Manifest env overlays it (A9). */
    readonly childEnv?: Readonly<Record<string, string>>;
  },
): StdioLaunch {
  const pluginData = options.pluginData;
  mkdirSync(pluginData, { recursive: true });
  const pluginRoot = options.pluginRoot;
  if (needsPluginRoot(server) && !pluginRoot)
    throw new Error("stdio server requires a plugin root");
  for (const key of Object.keys(server.env ?? {})) {
    if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA")
      throw new Error(`stdio env must not set ${key}`);
  }
  const command = server.command.startsWith("./")
    ? resolve(pluginRoot!, server.command)
    : server.command;
  const args = (server.args ?? []).map((arg) =>
    expand(arg, pluginRoot, pluginData),
  );
  const cwd = server.cwd
    ? resolveContainedCwd(server.cwd, pluginRoot, pluginData)
    : (pluginRoot ?? pluginData);
  // childEnv under manifest env; HOME/TMPDIR from childEnv override Host defaults
  // that StdioClientTransport merges via getDefaultEnvironment() (R2).
  const env: Record<string, string> = { ...(options.childEnv ?? {}) };
  for (const [key, value] of Object.entries(server.env ?? {}))
    env[key] = expand(value, pluginRoot, pluginData);
  if (pluginRoot) env.PLUGIN_ROOT = pluginRoot;
  env.PLUGIN_DATA = pluginData;
  return { command, args, cwd, env };
}

function needsPluginRoot(
  server: Extract<McpServerManifest, { type: "stdio" }>,
): boolean {
  if (server.command.startsWith("./")) return true;
  const values = [
    ...(server.args ?? []),
    ...Object.values(server.env ?? {}),
    ...(server.cwd === undefined ? [] : [server.cwd]),
  ];
  return values.some((value) => value.includes(ROOT_TOKEN));
}

function expand(value: string, pluginRoot: string | undefined, pluginData: string): string {
  if (value.includes(ROOT_TOKEN) && !pluginRoot)
    throw new Error("stdio server requires a plugin root");
  return expandPluginPlaceholders(value, pluginRoot ?? "", pluginData);
}

function resolveContainedCwd(
  cwd: string,
  pluginRoot: string | undefined,
  pluginData: string,
): string {
  const expanded = expand(cwd, pluginRoot, pluginData);
  const base = cwdTargetsData(cwd) ? pluginData : pluginRoot;
  if (!base) throw new Error("stdio server requires a plugin root");
  const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);
  if (!isInside(base, absolute)) throw new Error(`Working directory escapes ${base}`);
  return absolute;
}

function cwdTargetsData(cwd: string): boolean {
  return cwd === DATA_TOKEN || cwd.startsWith(`${DATA_TOKEN}/`);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

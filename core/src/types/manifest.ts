import type { JsonObject } from "./shared.js";

/** Published manifest schema version (no top-level model — Runtime-owned). */
export type ManifestSchemaVersion = 3;

export interface ToolManifest {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
}

export interface SkillManifest {
  readonly name: string;
  readonly description: string;
}

export type McpServerManifest =
  | {
      readonly name: string;
      readonly type: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | {
      readonly name: string;
      readonly type: "streamable-http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly type: "sse";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface CapabilityManifest {
  readonly id: string;
  readonly type: "agent" | "agent-plugin";
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly instructions?: readonly string[];
  readonly skills?: Readonly<Record<string, SkillManifest>>;
  readonly tools?: readonly ToolManifest[];
  readonly mcpServers?: Readonly<Record<string, McpServerManifest>>;
  readonly beforeModelCall?: boolean;
  readonly afterModelCall?: boolean;
}

/** Reserved. Empty until later fields are defined. Omit `runtime` while it has no fields. */
export interface RuntimeManifest {}

export interface AgentManifest {
  readonly manifestSchemaVersion: ManifestSchemaVersion;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly capabilities: readonly CapabilityManifest[];
  readonly runtime?: RuntimeManifest;
}

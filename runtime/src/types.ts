import type { ZodObject } from "zod";
import type { Harness, HarnessOptions } from "@nylorun/harness";

export type HarnessFactory = (options: HarnessOptions) => Harness;

export type McpDeclaration = Readonly<{
  name: string;
  url: string;
  transport?: "streamable-http";
  secret?: string;
}>;

export type RunOptions = Readonly<{
  model: string;
  name?: string;
  secrets?: readonly string[];
  mcp?: readonly McpDeclaration[];
}>;

export type AgentSpecOptions = Readonly<{
  name: string;
  model: string;
  instructions?: string;
  secrets?: readonly string[];
  mcp?: readonly McpDeclaration[];
}>;

/** @deprecated Use AgentSpecOptions. */
export type AgentOptions = AgentSpecOptions;

/** The authored definition. The harness is selected by the AgentSpec() or Run() import, never by omission. */
export type AgentSpec = Readonly<{
  name?: string;
  model: string;
  harness: HarnessFactory;
  instructions?: string;
  secrets: readonly string[];
  mcp: readonly Readonly<Required<Pick<McpDeclaration, "name" | "url" | "transport">> & Pick<McpDeclaration, "secret">>[];
}>;

/** @deprecated Use AgentSpec. */
export type NylorunAgent = AgentSpec;

/** The build-resolved form, whose manifest identity is always present. */
export type AgentConfig = Readonly<{
  name: string;
  model: string;
  harness: HarnessFactory;
  instructions?: string;
  secrets: readonly string[];
  mcp: readonly Readonly<Required<Pick<McpDeclaration, "name" | "url" | "transport">> & Pick<McpDeclaration, "secret">>[];
}>;

export type ToolContext = Readonly<{
  signal: AbortSignal;
}>;

export type ToolDefinition<Input extends ZodObject = ZodObject, Output = unknown> = Readonly<{
  description: string;
  input: Input;
  sandbox?: boolean;
  maxCallsPerSession?: number;
  onErrorMessage?: string;
  run(input: import("zod").output<Input>, context: ToolContext): Output | Promise<Output> | AsyncIterable<Output>;
}>;

export type FolderEntry = Readonly<{
  name: string;
  kind: "file" | "directory";
}>;

export type FolderReader = Readonly<{
  read(path: string): Promise<Uint8Array | undefined>;
  list(path: string): Promise<readonly FolderEntry[]>;
}>;

export type DiagnosticPhase = "check" | "build" | "hosted-readiness" | "run";

export type FolderDiagnostic = Readonly<{
  code: string;
  phase: DiagnosticPhase;
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  message: string;
  hint: string;
}>;

export type ValidationResult = Readonly<{
  ok: boolean;
  diagnostics: readonly FolderDiagnostic[];
}>;

export type ToolDescriptor = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  sandbox: boolean;
  maxCallsPerSession?: number;
}>;

export type SkillDescriptor = Readonly<{
  name: string;
  description: string;
  digest: string;
}>;

export type CapabilityManifest = Readonly<{
  formatVersion: 3;
  sdkVersion: string;
  agent: Readonly<{ name: string; model: string; secrets: readonly string[] }>;
  instructionsDigest: string;
  tools: readonly ToolDescriptor[];
  skills: readonly SkillDescriptor[];
  mcp: AgentConfig["mcp"];
  harness: Readonly<{
    name: "@nylorun/harness";
    version: string;
    capabilities: readonly string[];
  }>;
  requirements: Readonly<{
    tools: boolean;
    skills: boolean;
    mcp: boolean;
    interactions: boolean;
  }>;
  bundleDigest: string;
  digest: string;
}>;

export type BuildResult = Readonly<{
  ok: boolean;
  diagnostics: readonly FolderDiagnostic[];
  config?: AgentConfig;
  manifest?: CapabilityManifest;
  outputs?: readonly string[];
}>;

export type BuildOptions = Readonly<{
  mode?: "write" | "check";
}>;

export type ValidateOptions = Readonly<{
  strict?: boolean;
}>;

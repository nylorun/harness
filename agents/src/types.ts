import type { ZodType } from "zod";

export type McpDeclaration = Readonly<{
  name: string;
  url: string;
  transport?: "streamable-http";
  secret?: string;
}>;

export type AgentOptions = Readonly<{
  name: string;
  model: string;
  instructions?: string;
  secrets?: readonly string[];
  mcp?: readonly McpDeclaration[];
}>;

export type AgentConfig = Readonly<{
  name: string;
  model: string;
  instructions?: string;
  secrets: readonly string[];
  mcp: readonly Readonly<Required<Pick<McpDeclaration, "name" | "url" | "transport">> & Pick<McpDeclaration, "secret">>[];
}>;

export type ToolContext = Readonly<{
  signal: AbortSignal;
}>;

export type ToolDefinition<Input = unknown, Output = unknown> = Readonly<{
  description: string;
  input: ZodType<Input>;
  sandbox?: boolean;
  maxCallsPerSession?: number;
  onErrorMessage?: string;
  run(input: Input, context: ToolContext): Output | Promise<Output> | AsyncIterable<Output>;
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
  formatVersion: 1;
  sdkVersion: string;
  agent: Readonly<{ name: string; model: string; secrets: readonly string[] }>;
  instructionsDigest: string;
  tools: readonly ToolDescriptor[];
  skills: readonly SkillDescriptor[];
  mcp: AgentConfig["mcp"];
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

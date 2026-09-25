export type Compatibility = Readonly<{
  core: string;
  cli: string;
  harness: string;
  agents: string;
  admin: string;
  studio: string;
  runtime: string;
}>;

export type CreateOptions = Readonly<{
  directory: string;
  studio: boolean;
  open: boolean;
  yes: boolean;
}>;

export type Process = Readonly<{
  status: number | null;
  signal?: NodeJS.Signals | null;
}>;

export type CreatorDependencies = Readonly<{
  currentDirectory: () => string;
  isInteractive: () => boolean;
  log: (message: string) => void;
  signal?: AbortSignal;
  exists: (path: string) => Promise<boolean>;
  makeDirectory: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  write: (path: string, content: string) => Promise<void>;
  run: (
    command: string,
    args: readonly string[],
    directory: string,
  ) => Promise<Process>;
  /** `process.versions.node`: the Runtime needs Node 24 or newer. */
  nodeVersion: string;
  /** Path of `name` on PATH, or undefined (finds `nylorun-runtime`). */
  findOnPath: (name: string) => string | undefined;
}>;

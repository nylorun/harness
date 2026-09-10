export type Compatibility = Readonly<{
  harness: string;
  studio: string;
  runtime: string;
}>;

export type CreateOptions = Readonly<{
  directory: string;
  studio: boolean;
  open: boolean;
  yes: boolean;
  skipConfig?: boolean;
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
}>;

/**
 * Render launcher/bootstrap progress the way the Tenants-era CLI did:
 * phase name on stderr, with optional byte counts for downloads.
 */
export type ProgressEvent = {
  type: "progress";
  phase:
    | "download"
    | "verify"
    | "extract"
    | "install"
    | "start"
    | "stop"
    | "wait";
  received?: number;
  total?: number;
  message?: string;
};

export function renderProgress(
  event: ProgressEvent,
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): void {
  const parts: string[] = [event.phase];
  if (event.message) parts.push(event.message);
  if (event.received !== undefined) {
    parts.push(
      event.total !== undefined
        ? `${event.received}/${event.total}`
        : String(event.received),
    );
  }
  write(parts.join(" "));
}

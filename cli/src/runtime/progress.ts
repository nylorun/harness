/**
 * Render launcher progress the way the Tenants-era CLI did: phase name on
 * stderr.
 */
export type ProgressEvent = {
  type: "progress";
  phase: "start" | "stop" | "wait";
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
  write(parts.join(" "));
}

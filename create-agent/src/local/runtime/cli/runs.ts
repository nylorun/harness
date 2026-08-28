import { resolve } from "node:path";
import { createSessionJournal } from "../runtime/record-store.js";
import { styleFor } from "../runtime/render.js";
import type { Args } from "./args.js";
import { envelope } from "./index.js";

/**
 * Reading a record needs no agent, no build and no credential — which is the point. A session is
 * inspectable after the process that ran it is gone, without an account or a network.
 */
export async function runRecords(args: Args): Promise<number> {
  const style = styleFor(process.stdout.isTTY === true && !args.json);
  const journal = createSessionJournal({ projectRoot: resolve(args.project) });
  const [subcommand, id] = args.positionals;

  if (subcommand === undefined || subcommand === "list") {
    const summaries = await journal.list();
    if (args.json) {
      process.stdout.write(envelope("runs list", true, { runs: summaries }));
      return 0;
    }
    if (summaries.length === 0) {
      process.stdout.write(`${style.dim("no runs recorded — start a session through `nylo serve`, or check --project")}\n`);
      return 0;
    }
    for (const summary of summaries) {
      const when = summary.startedAt === 0 ? "unknown" : new Date(summary.startedAt).toISOString();
      process.stdout.write(
        `${style.bold(summary.session)}  ${summary.status.padEnd(11)} ${when}  ${String(summary.events)} events\n`
      );
    }
    return 0;
  }

  if (subcommand === "show") {
    if (id === undefined) {
      process.stderr.write(`${style.red("error")} nylo runs show needs a session id.\n`);
      return 2;
    }
    const summary = await journal.summary(id);
    const records = await journal.readRecords(id);
    const observe = await journal.readObserve(id);
    if (summary === undefined) {
      process.stderr.write(`${style.red("error")} no record for session ${id}.\n`);
      return 1;
    }
    if (args.json) {
      process.stdout.write(envelope("runs show", true, { summary, records: records ?? [], observe: observe ?? [] }));
      return 0;
    }
    process.stdout.write(`${style.bold(summary.session)} ${style.dim(summary.status)}\n`);
    process.stdout.write(`${style.dim("record")}\n`);
    for (const record of records ?? []) process.stdout.write(`${JSON.stringify(record)}\n`);
    process.stdout.write(`${style.dim("observe")}\n`);
    for (const event of observe ?? []) process.stdout.write(`${JSON.stringify(event)}\n`);
    return 0;
  }

  if (subcommand === "delete") {
    if (id === undefined) {
      process.stderr.write(`${style.red("error")} nylo runs delete needs a session id.\n`);
      return 2;
    }
    if (!args.yes && process.stdin.isTTY === true && !args.json) {
      process.stderr.write(`${style.red("error")} deleting a record cannot be undone.\n${style.dim("Re-run with --yes.")}\n`);
      return 2;
    }
    const removed = await journal.remove(id);
    if (args.json) {
      process.stdout.write(envelope("runs delete", removed, { session: id, removed }));
    } else if (removed) {
      process.stdout.write(`${style.dim("deleted")} ${id}\n`);
    } else {
      process.stderr.write(`${style.red("error")} no record for session ${id}.\n`);
    }
    return removed ? 0 : 1;
  }

  process.stderr.write(`${style.red("error")} unknown subcommand ${subcommand}.\n${style.dim("Use list, show or delete.")}\n`);
  return 2;
}

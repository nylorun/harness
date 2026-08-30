import { tool } from "@nylorun/harness";
import { z } from "zod";
import type { JsonlNotes } from "../services/notes-jsonl.js";

export function notes(notes: JsonlNotes) {
  return {
    id: "notes",
    instructions: [
      "Use write_note only when the user asks to save a note. A human approval is required before the write.",
    ],
    tools: [
      tool({
        name: "read_notes",
        description: "Read the most recent locally stored notes.",
        parameters: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
        async execute({ limit }) {
          return { kind: "completed" as const, output: { notes: await notes.recent(limit) } };
        },
      }),
      tool({
        name: "write_note",
        description: "Write a local JSONL note after the user approves.",
        parameters: z.object({ text: z.string().min(1).max(2_000) }),
        async execute({ text }, context) {
          if (context.resume?.approved === false) {
            return { kind: "denied" as const, reason: "The user declined the note write." };
          }
          return { kind: "completed" as const, output: { note: await notes.write(text) } };
        },
      }),
    ],
  } as const;
}

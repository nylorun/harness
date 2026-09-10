import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Note = Readonly<{ id: string; text: string; createdAt: string }>;

/** A deliberately small, explicit local persistence boundary. */
export class JsonlNotes {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async recent(limit = 5): Promise<readonly Note[]> {
    try {
      const rows = (await readFile(this.#path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Note);
      return rows.slice(-limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async write(text: string): Promise<Note> {
    const note = Object.freeze({
      id: crypto.randomUUID(),
      text,
      createdAt: new Date().toISOString(),
    });
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(note)}\n`, "utf8");
    return note;
  }
}

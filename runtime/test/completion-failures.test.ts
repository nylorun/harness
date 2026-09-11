import { expect, it } from "vitest";
import type {
  RuntimeAgent,
  RuntimeCompletion,
  RuntimeEvent,
} from "../src/contracts.js";
import { memoryHistory } from "../src/adapters/journal.js";
import { Runtime, serveAgents } from "../src/server/host.js";

const failures: { completion: RuntimeCompletion; message: string }[] = [
  {
    completion: {
      status: "completed",
      events: [
        {
          type: "tripwire",
          tripwire: { code: "input.blocked", message: "Blocked by policy." },
        },
      ],
    },
    message: "Blocked by policy.",
  },
  {
    completion: {
      status: "stopped",
      events: [
        { type: "tripwire", attributes: { message: "Stopped by policy." } },
      ],
    },
    message: "Stopped by policy.",
  },
  {
    completion: {
      status: "rejected",
      events: [{ type: "error", attributes: { message: "Provider failed." } }],
    },
    message: "Provider failed.",
  },
  ...(["rejected", "cancelled", "stopped"] as const).map((status) => ({
    completion: { status, events: [] },
    message: `Agent run ${status}.`,
  })),
];

it.each(failures)(
  "reports $completion.status completion failures without optional diagnostics",
  async ({ completion, message }) => {
    const agent: RuntimeAgent = {
      id: "failure",
      name: "Failure",
      manifest: { id: "failure", name: "Failure" },
      run: ({ id = "session" } = {}) => ({
        id,
        input: () => ({ completed: Promise.resolve(completion) }),
        async *stream() {},
        observe: () => () => {},
        async stop() {},
      }),
    };
    const runtime = new Runtime({
      observer: () => {},
      durability: memoryHistory(),
    });
    const app = serveAgents({ agents: [agent], runtime });
    try {
      // A previous run's failure must not suppress this run's terminal event.
      for (let run = 0; run < 2; run++) {
        const response = await app.request(
          "http://local/agents/failure/v1/ag-ui",
          {
            method: "POST",
            body: JSON.stringify({
              threadId: "session",
              messages: [{ role: "user", content: "hello" }],
            }),
          },
        );
        const events = (await response.text())
          .trim()
          .split("\n\n")
          .map((line) => JSON.parse(line.slice(6)));
        expect(events.map((event) => event.type)).toEqual([
          "RUN_STARTED",
          "RUN_ERROR",
        ]);
        expect(events[1].message).toBe(message);
        const status = await (
          await app.request(
            "http://local/agents/failure/v1/sessions/session",
          )
        ).json();
        expect(status.state).toBe("failed");
        const history = await (
          await app.request(
            "http://local/agents/failure/v1/sessions/session/events",
          )
        ).json();
        expect(
          history.events.filter(
            (event: RuntimeEvent) =>
              event.type === "error" || event.type === "tripwire",
          ),
        ).toHaveLength(run + 1);
      }
    } finally {
      await runtime.close();
    }
  },
);

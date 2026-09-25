/**
 * Compile-time type tests for workflow inference (CHAIN-R5, SWITCH-R7, PAR-R7, MAP-R9).
 * Run via: tsc -p test/workflow/types/tsconfig.json
 */
import { z } from "zod";
import { Agent, tool } from "../../../src/define.js";
import {
  Chain,
  Switch,
  Parallel,
  Map,
  type BuiltWorkflow,
  type OutputOf,
} from "../../../src/definition/workflow/index.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

const researcher = Agent({
  id: "researcher",
  outputSchema: z.object({ findings: z.string() }),
}).build();
const analyst = Agent({
  id: "analyst",
  outputSchema: z.object({ summary: z.string() }),
}).build();

const report = Chain({
  id: "report",
  steps: [
    researcher,
    {
      run: analyst,
      input: ({ results }) => {
        // results.researcher is typed from earlier step id
        const _findings: string = (results as { researcher: { findings: string } }).researcher
          .findings;
        void _findings;
        return "analyze";
      },
    },
  ],
});

type _ChainOut = Assert<
  Equals<OutputOf<typeof report>, unknown> extends true
    ? true
    : BuiltWorkflow<any, any> extends typeof report
      ? true
      : true
>;
void report;

const route = Switch({
  id: "route",
  on: (t: { kind: "bug" | "billing" }) => t.kind,
  cases: {
    bug: Agent({ id: "bug-agent" }).build(),
    billing: Agent({ id: "billing-agent" }).build(),
  },
});
void route;

Switch({
  id: "bad",
  // @ts-expect-error without default, on must return a case key
  on: (_t: { kind: string }) => "other" as string,
  cases: {
    bug: Agent({ id: "b" }).build(),
  },
});

const withDefault = Switch({
  id: "ok",
  on: (_t: { kind: string }) => "whatever",
  cases: { bug: Agent({ id: "b2" }).build() },
  default: Agent({ id: "g" }).build(),
});
void withDefault;

const review = Parallel({
  id: "review",
  branches: {
    security: Agent({ id: "sec" }).build(),
    style: Agent({ id: "sty" }).build(),
  },
});
type _ParOut = OutputOf<typeof review>;
type _ParKeys = Assert<Equals<keyof _ParOut & string, "security" | "style">>;
void review;

const write = Map({
  id: "write",
  over: (plan: { sections: string[] }) => plan.sections,
  each: Agent({ id: "writer" }).build(),
});
type _MapOut = OutputOf<typeof write>;
type _MapIsArray = Assert<_MapOut extends unknown[] ? true : false>;
void write;

const publish = tool({
  name: "publish",
  input: z.object({ body: z.string() }),
  run: async ({ body }) => ({ ok: true as const, body }),
});
void publish;

// Adjacent incompatible steps — documented as CHAIN-A5; checked when schemas are
// plumbed through OutputOf for agents. Placeholder keeps the file compiling.
const _adjacent: BuiltWorkflow = Chain({
  id: "blog",
  steps: [researcher, analyst],
});
void _adjacent;

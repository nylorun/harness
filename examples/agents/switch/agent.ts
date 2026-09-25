import { Agent, Chain, Switch } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Switch: pick one case by a key your code computes from the input.
 * Design: docs/design/workflows/switch.md
 */
const triager = Agent({
  id: "triager",
  name: "Triager",
  description: "Classifies a support ticket.",
  instructions: "Classify the ticket. Return kind and a short summary.",
  outputSchema: z.object({
    kind: z.enum(["bug", "billing", "other"]),
    summary: z.string(),
  }),
}).build();

const bugAgent = Agent({
  id: "bug-agent",
  name: "Bug agent",
  description: "Handles bug tickets.",
  instructions: "Help with the bug. Be concrete.",
}).build();

const billingAgent = Agent({
  id: "billing-agent",
  name: "Billing agent",
  description: "Handles billing tickets.",
  instructions: "Help with billing. Be precise about amounts and dates.",
}).build();

const generalAgent = Agent({
  id: "general-agent",
  name: "General agent",
  description: "Handles other tickets.",
  instructions: "Help with the ticket.",
}).build();

export const support = Chain({
  id: "support",
  steps: [
    triager,
    Switch({
      id: "route",
      on: (ticket) => (ticket as { kind: string }).kind,
      cases: { bug: bugAgent, billing: billingAgent },
      default: generalAgent,
    }),
  ],
});

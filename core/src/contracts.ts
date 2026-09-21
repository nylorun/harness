/** Public wire contracts only. Never import checkpoint or engine modules here. */
import { z } from "zod";
import type { AgentManifest } from "./types/manifest.js";
export type { AgentManifest } from "./types/manifest.js";
export const PROTOCOL_VERSION = 1;
export const RequestIdSchema = z.string().min(1);
export const IdempotencyKeySchema = z.string().min(1).max(256);
const jsonObject = z.record(z.string(), z.unknown());
export const AgentManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string().min(1),
    name: z.string().min(1),
    outputSchema: jsonObject.optional(),
    capabilities: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum(["agent", "capability", "middleware"]),
          hasMiddleware: z.boolean(),
          instructions: z.array(z.string()).optional(),
          tools: z
            .array(
              z
                .object({
                  name: z.string().min(1),
                  description: z.string().optional(),
                  inputSchema: jsonObject,
                  outputSchema: jsonObject.optional(),
                })
                .strict()
            )
            .optional(),
          beforeModelCall: z.boolean().optional(),
          afterModelCall: z.boolean().optional(),
        })
        .strict()
    ),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const capability of manifest.capabilities) {
      if (ids.has(capability.id))
        ctx.addIssue({ code: "custom", message: "Duplicate capability id" });
      ids.add(capability.id);
      // Arbitrary middleware closures cannot be transported. Hooks are explicit remote actions.
      if (capability.hasMiddleware)
        ctx.addIssue({
          code: "custom",
          message:
            "Hosted definitions support declarative capabilities and before/after hooks, not middleware closures",
        });
      for (const tool of capability.tools ?? []) {
        if (names.has(tool.name))
          ctx.addIssue({
            code: "custom",
            message: "Tool names must be unique",
          });
        names.add(tool.name);
      }
    }
  }) as unknown as z.ZodType<AgentManifest>;
export const PutAgentRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    manifest: AgentManifestSchema,
    implementationVersion: z.string().min(1),
  })
  .strict();
export type PutAgentRequest = z.infer<typeof PutAgentRequestSchema>;
export const PutSessionRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    agentId: z.string().min(1),
    ownerUserId: z.string().min(1),
    info: jsonObject.optional(),
  })
  .strict();
export type PutSessionRequest = z.infer<typeof PutSessionRequestSchema>;
const commandBase = {
  requestId: RequestIdSchema,
  idempotencyKey: IdempotencyKeySchema,
};
export const MessageEventBodySchema = z
  .object({
    ...commandBase,
    type: z.literal("message"),
    content: z.string().min(1),
  })
  .strict();
export const ActionOutcomeSchema = z
  .object({
    value: z.unknown(),
    statePatch: jsonObject.optional(),
  })
  .strict();
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;
export const ActionResultCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("action_result"),
    actionId: z.string().min(1),
    claimId: z.string().min(1),
    generation: z.number().int().positive(),
    outcome: ActionOutcomeSchema,
  })
  .strict();
export const SessionCommandSchema = z.discriminatedUnion("type", [
  MessageEventBodySchema,
  z
    .object({
      ...commandBase,
      type: z.literal("approve"),
      interactionId: z.string().min(1),
      approved: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("respond"),
      interactionId: z.string().min(1),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("cancel"),
      reason: z.string().optional(),
    })
    .strict(),
  ActionResultCommandSchema,
]);
export const SessionEventBodySchema = SessionCommandSchema;
export type SessionCommand = z.infer<typeof SessionCommandSchema>;
export type SessionEventBody = SessionCommand;
export type MessageEventBody = z.infer<typeof MessageEventBodySchema>;
export const LiveEventSchema = z
  .object({
    eventId: z.string(),
    sessionId: z.string(),
    turnId: z.string().nullable(),
    cursor: z.string(),
    createdAt: z.string(),
    type: z.string(),
    payload: z.unknown(),
  })
  .strict();
export type LiveEvent = z.infer<typeof LiveEventSchema>;
export const SessionItemsResponseSchema = z.object({
  items: z.array(LiveEventSchema),
  cursor: z.string().nullable(),
});
export type SessionItemsResponse = z.infer<typeof SessionItemsResponseSchema>;
export const AcceptedResponseSchema = z.object({
  status: z.literal("accepted"),
  turnId: z.string().nullable(),
  cursor: z.string().nullable(),
  requestId: z.string(),
});
export type AcceptedResponse = z.infer<typeof AcceptedResponseSchema>;
export const RejectedResponseSchema = z.object({
  status: z.literal("rejected"),
  code: z.string(),
  message: z.string(),
  activeTurnId: z.string().optional(),
  requestId: z.string().optional(),
});
export type RejectedResponse = z.infer<typeof RejectedResponseSchema>;
export const ActionSchema = z.object({
  actionId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  agentId: z.string(),
  manifestHash: z.string(),
  implementationVersion: z.string(),
  kind: z.enum(["tool", "beforeModelCall", "afterModelCall"]),
  capabilityId: z.string(),
  toolName: z.string().optional(),
  input: z.unknown(),
  context: jsonObject,
  status: z.enum(["pending", "claimed", "completed", "uncertain", "cancelled"]),
  generation: z.number().int().nonnegative(),
  claimId: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
});
export type Action = z.infer<typeof ActionSchema>;
export const ActionClaimRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    manifestHash: z.string().min(1),
    implementationVersion: z.string().min(1),
  })
  .strict();
export const ActionHeartbeatRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    claimId: z.string().min(1),
    generation: z.number().int().positive(),
  })
  .strict();
export const ActionClaimResponseSchema = z.object({
  action: ActionSchema,
  claimId: z.string(),
  generation: z.number().int().positive(),
  leaseExpiresAt: z.string(),
});
export type ActionClaim = z.infer<typeof ActionClaimResponseSchema>;
export interface ExecutorScope {
  readonly agentId: string;
  readonly manifestHash: string;
  readonly implementationVersion: string;
}
export const ExecutorNotificationSchema = z.object({
  type: z.literal("work_available"),
});
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
});
export const ReadyResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  service: z.string(),
  checks: z.record(z.string(), z.boolean()),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

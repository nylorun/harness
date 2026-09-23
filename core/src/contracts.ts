/** Public wire contracts only. Never import checkpoint or engine modules here. */
import { z } from "zod";
import type { AgentManifest } from "./types/manifest.js";
export type { AgentManifest } from "./types/manifest.js";
export const PROTOCOL_VERSION = 1;
export const RequestIdSchema = z.string().min(1);
export const IdempotencyKeySchema = z.string().min(1).max(256);
const jsonObject = z.record(z.string(), z.unknown());
const mcpServerSchema = z.discriminatedUnion("type", [
  z
    .object({
      name: z.string().min(1),
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      type: z.literal("streamable-http"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      type: z.literal("sse"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);
const skillManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
const toolManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: jsonObject,
    outputSchema: jsonObject.optional(),
  })
  .strict();
export const AgentManifestSchema = z
  .object({
    manifestSchemaVersion: z.literal(3),
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    metadata: jsonObject.optional(),
    outputSchema: jsonObject.optional(),
    capabilities: z.array(
      z
        .object({
          id: z.string().min(1),
          type: z.enum(["agent", "agent-plugin"]),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          metadata: jsonObject.optional(),
          instructions: z.array(z.string()).optional(),
          skills: z.record(z.string(), skillManifestSchema).optional(),
          tools: z.array(toolManifestSchema).optional(),
          mcpServers: z.record(z.string(), mcpServerSchema).optional(),
          beforeModelCall: z.boolean().optional(),
          afterModelCall: z.boolean().optional(),
        })
        .strict()
    ),
    runtime: z.object({}).strict().optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    const servers = new Set<string>();
    const skills = new Set<string>();
    for (const capability of manifest.capabilities) {
      if (ids.has(capability.id))
        ctx.addIssue({ code: "custom", message: "Duplicate capability id" });
      ids.add(capability.id);
      for (const tool of capability.tools ?? []) {
        if (names.has(tool.name))
          ctx.addIssue({
            code: "custom",
            message: "Tool names must be unique",
          });
        names.add(tool.name);
      }
      if (capability.skills && Object.keys(capability.skills).length === 0)
        ctx.addIssue({
          code: "custom",
          message: "skills must be omitted when a capability declares no skills",
        });
      for (const [key, skill] of Object.entries(capability.skills ?? {})) {
        if (key !== skill.name)
          ctx.addIssue({
            code: "custom",
            message: `skills key '${key}' must equal the skill name`,
          });
        if (skills.has(skill.name))
          ctx.addIssue({
            code: "custom",
            message: `Duplicate skill '${skill.name}'`,
          });
        skills.add(skill.name);
      }
      if (capability.mcpServers && Object.keys(capability.mcpServers).length === 0)
        ctx.addIssue({
          code: "custom",
          message: "mcpServers must be omitted when a capability declares no servers",
        });
      for (const [key, server] of Object.entries(capability.mcpServers ?? {})) {
        if (key !== server.name)
          ctx.addIssue({
            code: "custom",
            message: `mcpServers key '${key}' must equal the server name`,
          });
        if (servers.has(server.name))
          ctx.addIssue({
            code: "custom",
            message: `Duplicate MCP server '${server.name}'`,
          });
        servers.add(server.name);
      }
    }
  }) as unknown as z.ZodType<AgentManifest>;
const absolutePath = z.string().min(1).refine(
  (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
  { message: "plugin root must be an absolute path" },
);
export const PutAgentRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    manifest: AgentManifestSchema,
    implementationVersion: z.string().min(1),
    pluginRoots: z.record(z.string(), absolutePath).optional(),
  })
  .strict();
export type PutAgentRequest = z.infer<typeof PutAgentRequestSchema>;
export const CredentialSelectionSchema = z
  .object({
    serverName: z.string().min(1),
    credentialId: z.string().min(1),
  })
  .strict();
export type CredentialSelection = z.infer<typeof CredentialSelectionSchema>;
export const PutSessionRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    agentId: z.string().min(1),
    ownerUserId: z.string().min(1),
    info: jsonObject.optional(),
    vaultIds: z.array(z.string().min(1)).optional(),
    credentialSelections: z.array(CredentialSelectionSchema).optional(),
  })
  .strict();
export type PutSessionRequest = z.infer<typeof PutSessionRequestSchema>;
const vaultWriteBase = {
  requestId: RequestIdSchema,
  idempotencyKey: IdempotencyKeySchema,
};
const tokenEndpointAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("client_secret_basic"),
      clientSecret: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("client_secret_post"),
      clientSecret: z.string().min(1),
    })
    .strict(),
]);
const oauthRefreshSchema = z
  .object({
    tokenEndpoint: z.string().min(1),
    clientId: z.string().min(1),
    refreshToken: z.string().min(1),
    tokenEndpointAuth: tokenEndpointAuthSchema,
  })
  .strict();
export const CreateVaultRequestSchema = z
  .object({
    ...vaultWriteBase,
    name: z.string().min(1),
    ownerUserId: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type CreateVaultRequest = z.infer<typeof CreateVaultRequestSchema>;
export const CreateCredentialRequestSchema = z
  .object({
    ...vaultWriteBase,
    name: z.string().min(1),
    auth: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("bearer"),
          url: z.string().min(1),
          token: z.string().min(1),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth"),
          url: z.string().min(1),
          accessToken: z.string().min(1),
          expiresAt: z.string().min(1).nullable().optional(),
          refresh: oauthRefreshSchema.optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type CreateCredentialRequest = z.infer<
  typeof CreateCredentialRequestSchema
>;
export const RotateCredentialRequestSchema = z
  .object({
    ...vaultWriteBase,
    auth: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("bearer"),
          token: z.string().min(1),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth"),
          accessToken: z.string().min(1),
          expiresAt: z.string().min(1).nullable().optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type RotateCredentialRequest = z.infer<
  typeof RotateCredentialRequestSchema
>;
export const PutHostModelRequestSchema = z
  .object({
    ...vaultWriteBase,
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
    auth: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("api_key"),
          key: z.string().min(1),
          env: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth"),
          refresh: z.string().min(1),
          access: z.string().min(1),
          expires: z.number(),
        })
        .passthrough(),
    ]),
  })
  .strict();
export type PutHostModelRequest = z.infer<typeof PutHostModelRequestSchema>;
export type HostModelView =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly provider: string;
      readonly model: string;
      readonly authType: "api_key" | "oauth";
      readonly baseUrl?: string;
    };
export const SelectHostModelRequestSchema = z
  .object({
    ...vaultWriteBase,
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
  })
  .strict();
export type SelectHostModelRequest = z.infer<
  typeof SelectHostModelRequestSchema
>;
export type HostModelProviderInfo = {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly authType: "api_key" | "oauth";
  readonly baseUrl?: string;
  readonly lastUpdated: string;
  readonly active: boolean;
};
export interface VaultInfo {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt: string;
}
export interface CredentialInfo {
  readonly id: string;
  readonly vaultId: string;
  readonly name: string;
  readonly type: "bearer" | "oauth";
  readonly binding: { readonly url: string };
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly rotatedAt?: string;
}
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
  inputSchema: jsonObject.optional(),
  outputSchema: jsonObject.optional(),
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
  readonly manifestHash?: string;
  readonly implementationVersion: string;
}
export const ExecutorNotificationSchema = z.object({
  type: z.literal("work_available"),
});
export const ExecutorRegistrationSchema = z
  .object({
    agentId: z.string().min(1),
    implementationVersion: z.string().min(1),
    manifestHash: z.string().min(1).optional(),
    token: z.string().min(16),
  })
  .strict();
export const RegisterExecutorsRequestSchema = z
  .object({
    executors: z.array(ExecutorRegistrationSchema).min(1).max(64),
  })
  .strict();
export const RegisterExecutorsResponseSchema = z.object({
  executors: z.array(
    z.object({
      agentId: z.string(),
      implementationVersion: z.string(),
      rotated: z.boolean(),
    })
  ),
});
export const ExecutorSummarySchema = z.object({
  agentId: z.string(),
  implementationVersion: z.string(),
  manifestHash: z.string().optional(),
  connected: z.boolean(),
  updatedAt: z.string(),
});
export const ListExecutorsResponseSchema = z.object({
  executors: z.array(ExecutorSummarySchema),
});
export type ExecutorRegistration = z.infer<typeof ExecutorRegistrationSchema>;
export type RegisterExecutorsResponse = z.infer<
  typeof RegisterExecutorsResponseSchema
>;
export type ExecutorSummary = z.infer<typeof ExecutorSummarySchema>;
// Health fields added after the beta stay optional so a new client can parse an older Runtime.
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  version: z.string().optional(),
  scopeId: z.string().optional(),
  pid: z.number().int().positive().optional(),
});
export const ReadyResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  service: z.string(),
  checks: z.record(z.string(), z.boolean()),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

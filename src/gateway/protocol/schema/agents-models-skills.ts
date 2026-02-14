import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    identity: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(NonEmptyString),
          theme: Type.Optional(NonEmptyString),
          emoji: Type.Optional(NonEmptyString),
          avatar: Type.Optional(NonEmptyString),
          avatarUrl: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

export const AgentsFileEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    missing: Type.Boolean(),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
  },
  { additionalProperties: false },
);

export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentsFilesSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsTestParamsSchema = Type.Object(
  {
    model: Type.Optional(NonEmptyString),
    provider: Type.Optional(NonEmptyString),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const ModelsTestResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    summary: Type.Optional(Type.String()),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    results: Type.Array(
      Type.Object(
        {
          provider: NonEmptyString,
          model: Type.Optional(NonEmptyString),
          status: NonEmptyString,
          error: Type.Optional(Type.String()),
          latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
          profileId: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
          source: Type.Optional(Type.String()),
          mode: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ToolsListParamsSchema = Type.Object(
  {
    providerId: Type.Optional(Type.String()),
    providerIds: Type.Optional(Type.Array(Type.String())),
    providerKind: Type.Optional(
      Type.Union([Type.Literal("companion"), Type.Literal("mcp"), Type.Literal("builtin")]),
    ),
    includeBuiltin: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ToolDefinitionSchema = Type.Object(
  {
    name: NonEmptyString,
    providerId: NonEmptyString,
    providerKind: Type.Optional(
      Type.Union([Type.Literal("companion"), Type.Literal("mcp"), Type.Literal("builtin")]),
    ),
    providerLabel: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    inputSchema: Type.Optional(Type.Unknown()),
    command: NonEmptyString,
    nodeId: Type.Optional(Type.String()),
    nodeName: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    implementationSource: Type.Optional(
      Type.Union([Type.Literal("official"), Type.Literal("trusted-substitute")]),
    ),
  },
  { additionalProperties: false },
);

export const ToolsListResultSchema = Type.Object({
  ok: Type.Boolean(),
  definitions: Type.Array(ToolDefinitionSchema),
});

export const ToolsCallParamsSchema = Type.Object(
  {
    providerId: NonEmptyString,
    toolName: NonEmptyString,
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const ToolsCallResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    providerId: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    result: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsListParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillListItemSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    description: Type.Optional(Type.String()),
    icon: Type.Optional(Type.String()),
    enabled: Type.Boolean(),
    source: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SkillsListResultSchema = Type.Object(
  {
    skills: Type.Array(SkillListItemSchema),
  },
  { additionalProperties: false },
);

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsInstallParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    installId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const SkillsUninstallParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsUpdateParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  },
  { additionalProperties: false },
);

export const McpProvidersSnapshotParamsSchema = Type.Object({}, { additionalProperties: false });

export const McpProviderFieldValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const McpProviderConnectionSchema = Type.Object(
  {
    type: Type.Literal("http"),
    deploymentUrl: NonEmptyString,
    authType: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("bearer")])),
  },
  { additionalProperties: false },
);

export const McpProviderStateSchema = Type.Object(
  {
    providerId: NonEmptyString,
    label: NonEmptyString,
    configured: Type.Boolean(),
    enabled: Type.Boolean(),
    available: Type.Boolean(),
    toolCount: Type.Integer({ minimum: 0 }),
    connection: Type.Optional(McpProviderConnectionSchema),
    iconUrl: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    homepage: Type.Optional(Type.String()),
    website: Type.Optional(Type.String()),
    docsUrl: Type.Optional(Type.String()),
    fields: Type.Optional(Type.Record(Type.String(), McpProviderFieldValueSchema)),
    region: Type.Optional(Type.String()),
    workspace: Type.Optional(Type.String()),
    scopes: Type.Optional(Type.Array(Type.String())),
    requiredSecrets: Type.Optional(Type.Array(Type.String())),
    statusHints: Type.Optional(Type.Array(Type.String())),
    secretState: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
    secretLengths: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
    updatedAt: Type.Optional(Type.String()),
    installedAt: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const McpProvidersSnapshotResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    hash: Type.Optional(Type.String()),
    providers: Type.Array(McpProviderStateSchema),
  },
  { additionalProperties: false },
);

export const McpProvidersApplyParamsSchema = Type.Object(
  {
    baseHash: Type.Optional(Type.String()),
    providers: Type.Array(
      Type.Object(
        {
          providerId: NonEmptyString,
          configured: Type.Optional(Type.Boolean()),
          enabled: Type.Optional(Type.Boolean()),
          label: Type.Optional(Type.String()),
          connection: Type.Optional(McpProviderConnectionSchema),
          fields: Type.Optional(Type.Record(Type.String(), McpProviderFieldValueSchema)),
          region: Type.Optional(Type.String()),
          workspace: Type.Optional(Type.String()),
          scopes: Type.Optional(Type.Array(Type.String())),
          requiredSecrets: Type.Optional(Type.Array(Type.String())),
          statusHints: Type.Optional(Type.Array(Type.String())),
          secretValues: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
          discoverTools: Type.Optional(Type.Boolean()),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const McpFieldErrorSchema = Type.Object(
  {
    providerId: Type.String(),
    field: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);

export const McpProvidersApplyResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    restartRequired: Type.Boolean(),
    restart: Type.Optional(Type.Unknown()),
    hash: Type.Optional(Type.String()),
    providers: Type.Array(McpProviderStateSchema),
    fieldErrors: Type.Optional(Type.Array(McpFieldErrorSchema)),
  },
  { additionalProperties: false },
);

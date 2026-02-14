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
    source: Type.Optional(Type.Union([Type.Literal("builtin"), Type.Literal("market")])),
    implementationSource: Type.Optional(
      Type.Union([Type.Literal("official"), Type.Literal("trusted-substitute"), Type.Literal("smithery")]),
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

export const McpPresetsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const McpPresetFieldOptionSchema = Type.Object(
  {
    value: NonEmptyString,
    label: NonEmptyString,
  },
  { additionalProperties: false },
);

export const McpPresetFieldSchema = Type.Object(
  {
    key: NonEmptyString,
    label: NonEmptyString,
    description: Type.Optional(Type.String()),
    type: Type.Union([
      Type.Literal("text"),
      Type.Literal("password"),
      Type.Literal("url"),
      Type.Literal("number"),
      Type.Literal("boolean"),
      Type.Literal("select"),
    ]),
    required: Type.Optional(Type.Boolean()),
    secret: Type.Optional(Type.Boolean()),
    placeholder: Type.Optional(Type.String()),
    options: Type.Optional(Type.Array(McpPresetFieldOptionSchema)),
    defaultValue: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
  },
  { additionalProperties: false },
);

export const McpPresetSchema = Type.Object(
  {
    presetId: NonEmptyString,
    providerId: NonEmptyString,
    label: NonEmptyString,
    description: NonEmptyString,
    iconKey: Type.Optional(Type.String()),
    implementationSource: Type.Optional(
      Type.Union([Type.Literal("official"), Type.Literal("trusted-substitute")]),
    ),
    statusHints: Type.Optional(Type.Array(Type.String())),
    requiredSecrets: Type.Optional(Type.Array(Type.String())),
    website: Type.Optional(Type.String()),
    docsUrl: Type.Optional(Type.String()),
    aliases: Type.Optional(Type.Array(Type.String())),
    fields: Type.Array(McpPresetFieldSchema),
  },
  { additionalProperties: false },
);

export const McpPresetsListResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    presets: Type.Array(McpPresetSchema),
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

export const McpProviderStateSchema = Type.Object(
  {
    providerId: NonEmptyString,
    presetId: NonEmptyString,
    source: Type.Optional(Type.Union([Type.Literal("builtin"), Type.Literal("market")])),
    implementationSource: Type.Optional(
      Type.Union([Type.Literal("official"), Type.Literal("trusted-substitute"), Type.Literal("smithery")]),
    ),
    qualifiedName: Type.Optional(Type.String()),
    label: NonEmptyString,
    configured: Type.Boolean(),
    enabled: Type.Boolean(),
    available: Type.Boolean(),
    lifecycleStage: Type.Optional(
      Type.Union([
        Type.Literal("not-installed"),
        Type.Literal("installed"),
        Type.Literal("configured"),
        Type.Literal("available"),
      ]),
    ),
    toolCount: Type.Integer({ minimum: 0 }),
    iconKey: Type.Optional(Type.String()),
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
    builtinProviders: Type.Array(McpProviderStateSchema),
    marketProviders: Type.Array(McpProviderStateSchema),
    marketConfig: Type.Object(
      {
        registryBaseUrl: Type.String(),
        apiKeyConfigured: Type.Boolean(),
        lastSyncAt: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
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
          presetId: Type.Optional(Type.String()),
          configured: Type.Optional(Type.Boolean()),
          enabled: Type.Optional(Type.Boolean()),
          label: Type.Optional(Type.String()),
          fields: Type.Optional(Type.Record(Type.String(), McpProviderFieldValueSchema)),
          region: Type.Optional(Type.String()),
          workspace: Type.Optional(Type.String()),
          scopes: Type.Optional(Type.Array(Type.String())),
          secretValues: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
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
    builtinProviders: Type.Array(McpProviderStateSchema),
    marketProviders: Type.Array(McpProviderStateSchema),
    marketConfig: Type.Object(
      {
        registryBaseUrl: Type.String(),
        apiKeyConfigured: Type.Boolean(),
        lastSyncAt: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    fieldErrors: Type.Optional(Type.Array(McpFieldErrorSchema)),
  },
  { additionalProperties: false },
);

export const McpMarketSearchParamsSchema = Type.Object(
  {
    query: Type.Optional(Type.String()),
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    registryBaseUrl: Type.Optional(Type.String()),
    smitheryApiKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

export const McpMarketItemSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    qualifiedName: NonEmptyString,
    namespace: Type.Optional(Type.String()),
    slug: Type.Optional(Type.String()),
    displayName: NonEmptyString,
    description: Type.Optional(Type.String()),
    iconUrl: Type.Optional(Type.String()),
    verified: Type.Optional(Type.Boolean()),
    useCount: Type.Optional(Type.Number()),
    remote: Type.Optional(Type.Boolean()),
    isDeployed: Type.Optional(Type.Boolean()),
    createdAt: Type.Optional(Type.String()),
    homepage: Type.Optional(Type.String()),
    owner: Type.Optional(Type.String()),
    score: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const McpMarketPaginationSchema = Type.Object(
  {
    currentPage: Type.Integer({ minimum: 1 }),
    pageSize: Type.Integer({ minimum: 1 }),
    totalPages: Type.Integer({ minimum: 1 }),
    totalCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const McpMarketSearchResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    registryBaseUrl: Type.String(),
    items: Type.Array(McpMarketItemSchema),
    pagination: McpMarketPaginationSchema,
  },
  { additionalProperties: false },
);

export const McpMarketDetailParamsSchema = Type.Object(
  {
    qualifiedName: NonEmptyString,
    registryBaseUrl: Type.Optional(Type.String()),
    smitheryApiKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

export const McpMarketConnectionSchema = Type.Object(
  {
    type: Type.Literal("http"),
    deploymentUrl: NonEmptyString,
    authType: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("bearer")])),
    configSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const McpMarketToolSchema = Type.Object(
  {
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const McpMarketDetailSchema = Type.Object(
  {
    qualifiedName: NonEmptyString,
    displayName: NonEmptyString,
    description: Type.Optional(Type.String()),
    iconUrl: Type.Optional(Type.String()),
    remote: Type.Optional(Type.Boolean()),
    homepage: Type.Optional(Type.String()),
    connections: Type.Array(McpMarketConnectionSchema),
    tools: Type.Array(McpMarketToolSchema),
  },
  { additionalProperties: false },
);

export const McpMarketDetailResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    registryBaseUrl: Type.String(),
    detail: McpMarketDetailSchema,
  },
  { additionalProperties: false },
);

export const McpMarketInstallParamsSchema = Type.Object(
  {
    baseHash: Type.Optional(Type.String()),
    qualifiedName: NonEmptyString,
    providerId: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    fields: Type.Optional(Type.Record(Type.String(), McpProviderFieldValueSchema)),
    secretValues: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    registryBaseUrl: Type.Optional(Type.String()),
    smitheryApiKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

export const McpMarketInstallResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    restartRequired: Type.Boolean(),
    restart: Type.Optional(Type.Unknown()),
    hash: Type.Optional(Type.String()),
    builtinProviders: Type.Array(McpProviderStateSchema),
    marketProviders: Type.Array(McpProviderStateSchema),
    marketConfig: Type.Object(
      {
        registryBaseUrl: Type.String(),
        apiKeyConfigured: Type.Boolean(),
        lastSyncAt: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    install: Type.Optional(
      Type.Object(
        {
          providerId: Type.String(),
          qualifiedName: Type.String(),
          preflight: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const McpMarketUninstallParamsSchema = Type.Object(
  {
    baseHash: Type.Optional(Type.String()),
    providerId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const McpMarketUninstallResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    restartRequired: Type.Boolean(),
    restart: Type.Optional(Type.Unknown()),
    hash: Type.Optional(Type.String()),
    builtinProviders: Type.Array(McpProviderStateSchema),
    marketProviders: Type.Array(McpProviderStateSchema),
    marketConfig: Type.Object(
      {
        registryBaseUrl: Type.String(),
        apiKeyConfigured: Type.Boolean(),
        lastSyncAt: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const McpMarketRefreshParamsSchema = Type.Object(
  {
    baseHash: Type.Optional(Type.String()),
    registryBaseUrl: Type.Optional(Type.String()),
    smitheryApiKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

export const McpMarketRefreshResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    restartRequired: Type.Boolean(),
    restart: Type.Optional(Type.Unknown()),
    hash: Type.Optional(Type.String()),
    builtinProviders: Type.Array(McpProviderStateSchema),
    marketProviders: Type.Array(McpProviderStateSchema),
    marketConfig: Type.Object(
      {
        registryBaseUrl: Type.String(),
        apiKeyConfigured: Type.Boolean(),
        lastSyncAt: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    warnings: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

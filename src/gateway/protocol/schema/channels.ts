import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const TalkModeParamsSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    phase: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChannelsStatusParamsSchema = Type.Object(
  {
    probe: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

// Channel docking: channels.status is intentionally schema-light so new
// channels can ship without protocol updates.
export const ChannelAccountSnapshotSchema = Type.Object(
  {
    accountId: NonEmptyString,
    name: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    configured: Type.Optional(Type.Boolean()),
    linked: Type.Optional(Type.Boolean()),
    running: Type.Optional(Type.Boolean()),
    connected: Type.Optional(Type.Boolean()),
    reconnectAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
    lastConnectedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastError: Type.Optional(Type.String()),
    lastStartAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastStopAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastInboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastOutboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastProbeAt: Type.Optional(Type.Integer({ minimum: 0 })),
    mode: Type.Optional(Type.String()),
    dmPolicy: Type.Optional(Type.String()),
    allowFrom: Type.Optional(Type.Array(Type.String())),
    tokenSource: Type.Optional(Type.String()),
    botTokenSource: Type.Optional(Type.String()),
    appTokenSource: Type.Optional(Type.String()),
    baseUrl: Type.Optional(Type.String()),
    allowUnmentionedGroups: Type.Optional(Type.Boolean()),
    cliPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    dbPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    port: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    probe: Type.Optional(Type.Unknown()),
    audit: Type.Optional(Type.Unknown()),
    application: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

export const ChannelUiMetaSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    detailLabel: NonEmptyString,
    systemImage: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChannelsStatusResultSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    channelOrder: Type.Array(NonEmptyString),
    channelLabels: Type.Record(NonEmptyString, NonEmptyString),
    channelDetailLabels: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
    channelSystemImages: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
    channelMeta: Type.Optional(Type.Array(ChannelUiMetaSchema)),
    channels: Type.Record(NonEmptyString, Type.Unknown()),
    channelAccounts: Type.Record(NonEmptyString, Type.Array(ChannelAccountSnapshotSchema)),
    channelDefaultAccountId: Type.Record(NonEmptyString, NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChannelsLogoutParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChannelsAddParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    account: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    token: Type.Optional(Type.String()),
    tokenFile: Type.Optional(Type.String()),
    botToken: Type.Optional(Type.String()),
    appToken: Type.Optional(Type.String()),
    signalNumber: Type.Optional(Type.String()),
    cliPath: Type.Optional(Type.String()),
    dbPath: Type.Optional(Type.String()),
    service: Type.Optional(Type.String()),
    region: Type.Optional(Type.String()),
    authDir: Type.Optional(Type.String()),
    httpUrl: Type.Optional(Type.String()),
    httpHost: Type.Optional(Type.String()),
    httpPort: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.String()])),
    webhookPath: Type.Optional(Type.String()),
    webhookUrl: Type.Optional(Type.String()),
    audienceType: Type.Optional(Type.String()),
    audience: Type.Optional(Type.String()),
    useEnv: Type.Optional(Type.Boolean()),
    homeserver: Type.Optional(Type.String()),
    userId: Type.Optional(Type.String()),
    accessToken: Type.Optional(Type.String()),
    password: Type.Optional(Type.String()),
    deviceName: Type.Optional(Type.String()),
    initialSyncLimit: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.String()])),
    ship: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    code: Type.Optional(Type.String()),
    groupChannels: Type.Optional(Type.String()),
    dmAllowlist: Type.Optional(Type.String()),
    dmPolicy: Type.Optional(Type.String()),
    allowFrom: Type.Optional(Type.String()),
    autoDiscoverChannels: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

export const PairingListParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PairingApproveParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    code: NonEmptyString,
    notify: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ChannelsRemoveParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    account: Type.Optional(Type.String()),
    delete: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ChannelsLoginParamsSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    account: Type.Optional(Type.String()),
    verbose: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ChannelsListParamsSchema = Type.Object(
  {
    usage: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ChannelsCapabilitiesParamsSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    account: Type.Optional(Type.String()),
    target: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ChannelsResolveParamsSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    account: Type.Optional(Type.String()),
    kind: Type.Optional(Type.String()),
    entries: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const ChannelsLogsParamsSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    lines: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const WebLoginStartParamsSchema = Type.Object(
  {
    force: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    verbose: Type.Optional(Type.Boolean()),
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WebLoginWaitParamsSchema = Type.Object(
  {
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

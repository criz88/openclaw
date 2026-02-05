import type { Static } from "@sinclair/typebox";
import type {
  AgentEventSchema,
  AgentIdentityParamsSchema,
  AgentIdentityResultSchema,
  AgentWaitParamsSchema,
  PollParamsSchema,
  WakeParamsSchema,
} from "./agent.js";
import type {
  AgentSummarySchema,
  AgentsFileEntrySchema,
  AgentsFilesGetParamsSchema,
  AgentsFilesGetResultSchema,
  AgentsFilesListParamsSchema,
  AgentsFilesListResultSchema,
  AgentsFilesSetParamsSchema,
  AgentsFilesSetResultSchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  ModelChoiceSchema,
  ModelsListParamsSchema,
  ModelsTestParamsSchema,
  ModelsTestResultSchema,
  ToolsListParamsSchema,
  ToolsListResultSchema,
  ModelsListResultSchema,
  SkillsBinsParamsSchema,
  SkillsBinsResultSchema,
  SkillsInstallParamsSchema,
  SkillsStatusParamsSchema,
  SkillsListParamsSchema,
  SkillsListResultSchema,
  SkillsUninstallParamsSchema,
  SkillsUpdateParamsSchema,
  SkillListItemSchema,
} from "./agents-models-skills.js";
import type {
  ChannelsLogoutParamsSchema,
  ChannelsAddParamsSchema,
  ChannelsRemoveParamsSchema,
  ChannelsLoginParamsSchema,
  ChannelsListParamsSchema,
  ChannelsCapabilitiesParamsSchema,
  ChannelsResolveParamsSchema,
  ChannelsLogsParamsSchema,
  PairingListParamsSchema,
  PairingApproveParamsSchema,
  ChannelsStatusParamsSchema,
  ChannelsStatusResultSchema,
  TalkModeParamsSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
} from "./channels.js";
import type {
  ConfigApplyParamsSchema,
  ConfigGetParamsSchema,
  ConfigPatchParamsSchema,
  ConfigSchemaParamsSchema,
  ConfigSchemaResponseSchema,
  ConfigSetParamsSchema,
  UpdateRunParamsSchema,
} from "./config.js";
import type {
  CronAddParamsSchema,
  CronJobSchema,
  CronListParamsSchema,
  CronRemoveParamsSchema,
  CronRunLogEntrySchema,
  CronRunParamsSchema,
  CronRunsParamsSchema,
  CronStatusParamsSchema,
  CronUpdateParamsSchema,
} from "./cron.js";
import type {
  DevicePairApproveParamsSchema,
  DevicePairListParamsSchema,
  DevicePairRejectParamsSchema,
  DeviceTokenRevokeParamsSchema,
  DeviceTokenRotateParamsSchema,
} from "./devices.js";
import type {
  ExecApprovalsGetParamsSchema,
  ExecApprovalsNodeGetParamsSchema,
  ExecApprovalsNodeSetParamsSchema,
  ExecApprovalsSetParamsSchema,
  ExecApprovalsSnapshotSchema,
  ExecApprovalRequestParamsSchema,
  ExecApprovalResolveParamsSchema,
} from "./exec-approvals.js";
import type {
  ConnectParamsSchema,
  ErrorShapeSchema,
  EventFrameSchema,
  GatewayFrameSchema,
  HelloOkSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  ShutdownEventSchema,
  TickEventSchema,
} from "./frames.js";
import type {
  ChatAbortParamsSchema,
  ChatEventSchema,
  ChatInjectParamsSchema,
  LogsTailParamsSchema,
  LogsTailResultSchema,
} from "./logs-chat.js";
import type {
  NodeDescribeParamsSchema,
  NodeEventParamsSchema,
  NodeInvokeParamsSchema,
  NodeInvokeResultParamsSchema,
  NodeListParamsSchema,
  NodePairApproveParamsSchema,
  NodePairListParamsSchema,
  NodePairRejectParamsSchema,
  NodePairRequestParamsSchema,
  NodePairVerifyParamsSchema,
  NodeRenameParamsSchema,
} from "./nodes.js";
import type {
  SessionsCompactParamsSchema,
  SessionsDeleteParamsSchema,
  SessionsListParamsSchema,
  SessionsPatchParamsSchema,
  SessionsPreviewParamsSchema,
  SessionsResetParamsSchema,
  SessionsResolveParamsSchema,
} from "./sessions.js";
import type { PresenceEntrySchema, SnapshotSchema, StateVersionSchema } from "./snapshot.js";
import type {
  OverviewSummaryParamsSchema,
  OverviewSummaryResultSchema,
} from "./overview.js";
import type {
  WizardCancelParamsSchema,
  WizardNextParamsSchema,
  WizardNextResultSchema,
  WizardStartParamsSchema,
  WizardStartResultSchema,
  WizardStatusParamsSchema,
  WizardStatusResultSchema,
  WizardStepSchema,
} from "./wizard.js";

export type ConnectParams = Static<typeof ConnectParamsSchema>;
export type HelloOk = Static<typeof HelloOkSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
export type GatewayFrame = Static<typeof GatewayFrameSchema>;
export type Snapshot = Static<typeof SnapshotSchema>;
export type PresenceEntry = Static<typeof PresenceEntrySchema>;
export type ErrorShape = Static<typeof ErrorShapeSchema>;
export type StateVersion = Static<typeof StateVersionSchema>;
export type AgentEvent = Static<typeof AgentEventSchema>;
export type AgentIdentityParams = Static<typeof AgentIdentityParamsSchema>;
export type AgentIdentityResult = Static<typeof AgentIdentityResultSchema>;
export type PollParams = Static<typeof PollParamsSchema>;
export type AgentWaitParams = Static<typeof AgentWaitParamsSchema>;
export type WakeParams = Static<typeof WakeParamsSchema>;
export type NodePairRequestParams = Static<typeof NodePairRequestParamsSchema>;
export type NodePairListParams = Static<typeof NodePairListParamsSchema>;
export type NodePairApproveParams = Static<typeof NodePairApproveParamsSchema>;
export type NodePairRejectParams = Static<typeof NodePairRejectParamsSchema>;
export type NodePairVerifyParams = Static<typeof NodePairVerifyParamsSchema>;
export type NodeRenameParams = Static<typeof NodeRenameParamsSchema>;
export type NodeListParams = Static<typeof NodeListParamsSchema>;
export type NodeDescribeParams = Static<typeof NodeDescribeParamsSchema>;
export type NodeInvokeParams = Static<typeof NodeInvokeParamsSchema>;
export type NodeInvokeResultParams = Static<typeof NodeInvokeResultParamsSchema>;
export type NodeEventParams = Static<typeof NodeEventParamsSchema>;
export type SessionsListParams = Static<typeof SessionsListParamsSchema>;
export type SessionsPreviewParams = Static<typeof SessionsPreviewParamsSchema>;
export type SessionsResolveParams = Static<typeof SessionsResolveParamsSchema>;
export type SessionsPatchParams = Static<typeof SessionsPatchParamsSchema>;
export type SessionsResetParams = Static<typeof SessionsResetParamsSchema>;
export type SessionsDeleteParams = Static<typeof SessionsDeleteParamsSchema>;
export type SessionsCompactParams = Static<typeof SessionsCompactParamsSchema>;
export type ConfigGetParams = Static<typeof ConfigGetParamsSchema>;
export type ConfigSetParams = Static<typeof ConfigSetParamsSchema>;
export type ConfigApplyParams = Static<typeof ConfigApplyParamsSchema>;
export type ConfigPatchParams = Static<typeof ConfigPatchParamsSchema>;
export type ConfigSchemaParams = Static<typeof ConfigSchemaParamsSchema>;
export type ConfigSchemaResponse = Static<typeof ConfigSchemaResponseSchema>;
export type WizardStartParams = Static<typeof WizardStartParamsSchema>;
export type WizardNextParams = Static<typeof WizardNextParamsSchema>;
export type WizardCancelParams = Static<typeof WizardCancelParamsSchema>;
export type WizardStatusParams = Static<typeof WizardStatusParamsSchema>;
export type WizardStep = Static<typeof WizardStepSchema>;
export type WizardNextResult = Static<typeof WizardNextResultSchema>;
export type WizardStartResult = Static<typeof WizardStartResultSchema>;
export type WizardStatusResult = Static<typeof WizardStatusResultSchema>;
export type TalkModeParams = Static<typeof TalkModeParamsSchema>;
export type ChannelsStatusParams = Static<typeof ChannelsStatusParamsSchema>;
export type ChannelsStatusResult = Static<typeof ChannelsStatusResultSchema>;
export type ChannelsLogoutParams = Static<typeof ChannelsLogoutParamsSchema>;
export type ChannelsAddParams = Static<typeof ChannelsAddParamsSchema>;
export type ChannelsRemoveParams = Static<typeof ChannelsRemoveParamsSchema>;
export type ChannelsLoginParams = Static<typeof ChannelsLoginParamsSchema>;
export type ChannelsListParams = Static<typeof ChannelsListParamsSchema>;
export type ChannelsCapabilitiesParams = Static<typeof ChannelsCapabilitiesParamsSchema>;
export type ChannelsResolveParams = Static<typeof ChannelsResolveParamsSchema>;
export type ChannelsLogsParams = Static<typeof ChannelsLogsParamsSchema>;
export type PairingListParams = Static<typeof PairingListParamsSchema>;
export type PairingApproveParams = Static<typeof PairingApproveParamsSchema>;
export type WebLoginStartParams = Static<typeof WebLoginStartParamsSchema>;
export type WebLoginWaitParams = Static<typeof WebLoginWaitParamsSchema>;
export type AgentSummary = Static<typeof AgentSummarySchema>;
export type AgentsFileEntry = Static<typeof AgentsFileEntrySchema>;
export type AgentsFilesListParams = Static<typeof AgentsFilesListParamsSchema>;
export type AgentsFilesListResult = Static<typeof AgentsFilesListResultSchema>;
export type AgentsFilesGetParams = Static<typeof AgentsFilesGetParamsSchema>;
export type AgentsFilesGetResult = Static<typeof AgentsFilesGetResultSchema>;
export type AgentsFilesSetParams = Static<typeof AgentsFilesSetParamsSchema>;
export type AgentsFilesSetResult = Static<typeof AgentsFilesSetResultSchema>;
export type AgentsListParams = Static<typeof AgentsListParamsSchema>;
export type AgentsListResult = Static<typeof AgentsListResultSchema>;
export type OverviewSummaryParams = Static<typeof OverviewSummaryParamsSchema>;
export type OverviewSummaryResult = Static<typeof OverviewSummaryResultSchema>;
export type ModelChoice = Static<typeof ModelChoiceSchema>;
export type ModelsListParams = Static<typeof ModelsListParamsSchema>;
export type ModelsTestParams = Static<typeof ModelsTestParamsSchema>;
export type ModelsTestResult = Static<typeof ModelsTestResultSchema>;
export type ToolsListParams = Static<typeof ToolsListParamsSchema>;
export type ToolsListResult = Static<typeof ToolsListResultSchema>;
export type ModelsListResult = Static<typeof ModelsListResultSchema>;
export type SkillListItem = Static<typeof SkillListItemSchema>;
export type SkillsStatusParams = Static<typeof SkillsStatusParamsSchema>;
export type SkillsListParams = Static<typeof SkillsListParamsSchema>;
export type SkillsListResult = Static<typeof SkillsListResultSchema>;
export type SkillsBinsParams = Static<typeof SkillsBinsParamsSchema>;
export type SkillsBinsResult = Static<typeof SkillsBinsResultSchema>;
export type SkillsInstallParams = Static<typeof SkillsInstallParamsSchema>;
export type SkillsUninstallParams = Static<typeof SkillsUninstallParamsSchema>;
export type SkillsUpdateParams = Static<typeof SkillsUpdateParamsSchema>;
export type CronJob = Static<typeof CronJobSchema>;
export type CronListParams = Static<typeof CronListParamsSchema>;
export type CronStatusParams = Static<typeof CronStatusParamsSchema>;
export type CronAddParams = Static<typeof CronAddParamsSchema>;
export type CronUpdateParams = Static<typeof CronUpdateParamsSchema>;
export type CronRemoveParams = Static<typeof CronRemoveParamsSchema>;
export type CronRunParams = Static<typeof CronRunParamsSchema>;
export type CronRunsParams = Static<typeof CronRunsParamsSchema>;
export type CronRunLogEntry = Static<typeof CronRunLogEntrySchema>;
export type LogsTailParams = Static<typeof LogsTailParamsSchema>;
export type LogsTailResult = Static<typeof LogsTailResultSchema>;
export type ExecApprovalsGetParams = Static<typeof ExecApprovalsGetParamsSchema>;
export type ExecApprovalsSetParams = Static<typeof ExecApprovalsSetParamsSchema>;
export type ExecApprovalsNodeGetParams = Static<typeof ExecApprovalsNodeGetParamsSchema>;
export type ExecApprovalsNodeSetParams = Static<typeof ExecApprovalsNodeSetParamsSchema>;
export type ExecApprovalsSnapshot = Static<typeof ExecApprovalsSnapshotSchema>;
export type ExecApprovalRequestParams = Static<typeof ExecApprovalRequestParamsSchema>;
export type ExecApprovalResolveParams = Static<typeof ExecApprovalResolveParamsSchema>;
export type DevicePairListParams = Static<typeof DevicePairListParamsSchema>;
export type DevicePairApproveParams = Static<typeof DevicePairApproveParamsSchema>;
export type DevicePairRejectParams = Static<typeof DevicePairRejectParamsSchema>;
export type DeviceTokenRotateParams = Static<typeof DeviceTokenRotateParamsSchema>;
export type DeviceTokenRevokeParams = Static<typeof DeviceTokenRevokeParamsSchema>;
export type ChatAbortParams = Static<typeof ChatAbortParamsSchema>;
export type ChatInjectParams = Static<typeof ChatInjectParamsSchema>;
export type ChatEvent = Static<typeof ChatEventSchema>;
export type UpdateRunParams = Static<typeof UpdateRunParamsSchema>;
export type TickEvent = Static<typeof TickEventSchema>;
export type ShutdownEvent = Static<typeof ShutdownEventSchema>;

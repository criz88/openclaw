import type { ChannelAccountSnapshot, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { buildChannelUiCatalog } from "../../channels/plugins/catalog.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import {
  channelsAddCommand,
  channelsRemoveCommand,
  channelsListCommand,
  channelsCapabilitiesCommand,
  channelsResolveCommand,
  channelsLogsCommand,
} from "../../commands/channels.js";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
} from "../../pairing/pairing-store.js";
import {
  listPairingChannels,
  notifyPairingApproved,
  resolvePairingChannel,
} from "../../channels/plugins/pairing.js";
import { runChannelLogin, runChannelLogout } from "../../cli/channel-auth.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { listChatChannels } from "../../channels/registry.js";
import { listChannelPluginCatalogEntries } from "../../channels/plugins/catalog.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { discoverOpenClawPlugins } from "../../plugins/discovery.js";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChannelsLogoutParams,
  validateChannelsStatusParams,
  validateChannelsAddParams,
  validateChannelsRemoveParams,
  validateChannelsLoginParams,
  validateChannelsListParams,
  validateChannelsCapabilitiesParams,
  validateChannelsResolveParams,
  validateChannelsLogsParams,
  validatePairingListParams,
  validatePairingApproveParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";

type ChannelLogoutPayload = {
  channel: ChannelId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

export async function logoutChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload> {
  const resolvedAccountId =
    params.accountId?.trim() ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID;
  const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const result = await params.plugin.gateway?.logoutAccount?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    account,
    runtime: defaultRuntime,
  });
  if (!result) {
    throw new Error(`Channel ${params.channelId} does not support logout`);
  }
  const cleared = Boolean(result.cleared);
  const loggedOut = typeof result.loggedOut === "boolean" ? result.loggedOut : cleared;
  if (loggedOut) {
    params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
  }
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    ...result,
    cleared,
  };
}

const makeApiRuntime = (opts?: {
  onLog?: (msg: string) => void;
  onError?: (msg: string) => void;
}): RuntimeEnv => ({
  ...defaultRuntime,
  log: (...args: Parameters<typeof console.log>) => {
    const msg = args.map((entry) => String(entry)).join(" ");
    opts?.onLog?.(msg);
    defaultRuntime.log(...args);
  },
  error: (...args: Parameters<typeof console.error>) => {
    const msg = args.map((entry) => String(entry)).join(" ");
    opts?.onError?.(msg);
    defaultRuntime.error(...args);
  },
  exit: (code) => {
    throw new Error(`runtime.exit(${code})`);
  },
});

const extractJsonFromLog = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const start = Math.min(
    ...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((idx) => idx >= 0),
  );
  if (!Number.isFinite(start)) return null;
  const payload = trimmed.slice(start);
  return JSON.parse(payload);
};

async function runJsonCommand(run: (runtime: RuntimeEnv) => Promise<void>) {
  let output = "";
  let lastError = "";
  await run(
    makeApiRuntime({
      onLog: (msg) => {
        output += `${msg}\n`;
      },
      onError: (msg) => {
        lastError = msg;
      },
    }),
  );
  const parsed = extractJsonFromLog(output);
  if (parsed == null) {
    throw new Error(lastError || "No JSON output");
  }
  return parsed;
}

export const channelsHandlers: GatewayRequestHandlers = {
  "channels.add": async ({ params, respond }) => {
    if (!validateChannelsAddParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.add params"),
      );
      return;
    }
    const channelInput = typeof (params as any)?.channel === "string" ? (params as any).channel.trim() : "";
    const availableChannels = listChatChannels().map((entry) => entry.id);
    if (!channelInput) {
      respond(
        false,
        { availableChannels },
        errorShape(ErrorCodes.INVALID_REQUEST, "channel is required"),
      );
      return;
    }
    let installedChannels = listChannelPlugins().map((plugin) => plugin.id);
    let pluginDiagnostics: unknown[] | undefined;
    let pluginDiscovery: { bundledDir?: string; candidates?: string[] } | undefined;
    if (installedChannels.length === 0) {
      try {
        const cfg = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
        const registry = loadOpenClawPlugins({ config: cfg, workspaceDir });
        installedChannels = registry.channels.map((entry) => entry.plugin.id);
        pluginDiagnostics = registry.diagnostics;
        const discovery = discoverOpenClawPlugins({ workspaceDir });
        pluginDiscovery = {
          bundledDir: resolveBundledPluginsDir(),
          candidates: discovery.candidates.map((c) => c.idHint),
        };
      } catch (err) {
        pluginDiagnostics = [{ level: "error", message: String(err) }];
        pluginDiscovery = { bundledDir: resolveBundledPluginsDir(), candidates: [] };
      }
    }
    if (!installedChannels.includes(channelInput)) {
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
      const catalogChannels = listChannelPluginCatalogEntries({ workspaceDir }).map((entry) => entry.id);
      if (pluginDiscovery?.candidates?.includes(channelInput)) {
        const allow = Array.isArray(cfg.plugins?.allow) ? cfg.plugins?.allow : undefined;
        const nextAllow = allow && !allow.includes(channelInput) ? [...allow, channelInput] : allow;
        const nextConfig = {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            ...(cfg.plugins?.enabled === false ? { enabled: true } : {}),
            ...(nextAllow ? { allow: nextAllow } : {}),
            entries: {
              ...cfg.plugins?.entries,
              [channelInput]: {
                ...(cfg.plugins?.entries?.[channelInput] ?? {}),
                enabled: true,
              },
            },
          },
        };
        await writeConfigFile(nextConfig);
        const registry = loadOpenClawPlugins({ config: nextConfig, workspaceDir });
        installedChannels = registry.channels.map((entry) => entry.plugin.id);
        pluginDiagnostics = registry.diagnostics;
      }
      if (!installedChannels.includes(channelInput)) {
        respond(
          false,
          { availableChannels, installedChannels, catalogChannels, pluginDiagnostics, pluginDiscovery },
          errorShape(ErrorCodes.INVALID_REQUEST, `channel plugin not installed: ${channelInput}`),
        );
        return;
      }
    }
    let lastRuntimeError = "";
    try {
      await channelsAddCommand(params as any, makeApiRuntime((msg) => (lastRuntimeError = msg)), {
        hasFlags: true,
      });
      respond(true, { ok: true, action: "channels.add" }, undefined);
    } catch (err) {
      const message = lastRuntimeError || String(err);
      respond(
        false,
        { availableChannels, installedChannels },
        errorShape(ErrorCodes.INVALID_REQUEST, message),
      );
    }
  },
  "channels.list": async ({ params, respond }) => {
    if (!validateChannelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.list params"),
      );
      return;
    }
    try {
      const payload = await runJsonCommand((runtime) =>
        channelsListCommand(
          {
            json: true,
            usage: (params as any)?.usage !== false,
          },
          runtime,
        ),
      );
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "channels.capabilities": async ({ params, respond }) => {
    if (!validateChannelsCapabilitiesParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.capabilities params"),
      );
      return;
    }
    try {
      const timeoutMs = (params as any)?.timeoutMs;
      const payload = await runJsonCommand((runtime) =>
        channelsCapabilitiesCommand(
          {
            json: true,
            channel: (params as any)?.channel,
            account: (params as any)?.account,
            target: (params as any)?.target,
            timeout: typeof timeoutMs === "number" ? String(timeoutMs) : undefined,
          },
          runtime,
        ),
      );
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "channels.resolve": async ({ params, respond }) => {
    if (!validateChannelsResolveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.resolve params"),
      );
      return;
    }
    const channelInput = typeof (params as any)?.channel === "string" ? (params as any).channel.trim() : "";
    const plugin = channelInput ? getChannelPlugin(channelInput) : undefined;
    if (plugin && !plugin.resolver?.resolveTargets) {
      respond(
        false,
        { channel: plugin.id, supported: false },
        errorShape(ErrorCodes.INVALID_REQUEST, `Channel ${plugin.id} does not support resolve.`),
      );
      return;
    }
    try {
      const payload = await runJsonCommand((runtime) =>
        channelsResolveCommand(
          {
            json: true,
            channel: (params as any)?.channel,
            account: (params as any)?.account,
            kind: (params as any)?.kind,
            entries: (params as any)?.entries,
          },
          runtime,
        ),
      );
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "channels.logs": async ({ params, respond }) => {
    if (!validateChannelsLogsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.logs params"),
      );
      return;
    }
    try {
      const payload = await runJsonCommand((runtime) =>
        channelsLogsCommand(
          {
            json: true,
            channel: (params as any)?.channel,
            lines: (params as any)?.lines,
          },
          runtime,
        ),
      );
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "pairing.list": async ({ params, respond }) => {
    if (!validatePairingListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid pairing.list params"),
      );
      return;
    }
    try {
      const channel = resolvePairingChannel((params as any).channel);
      const requests = await listChannelPairingRequests(channel);
      respond(true, { channel, requests }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "pairing.approve": async ({ params, respond }) => {
    if (!validatePairingApproveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid pairing.approve params"),
      );
      return;
    }
    try {
      const channel = resolvePairingChannel((params as any).channel);
      const code = String((params as any).code || "").trim();
      const notify = (params as any).notify === true;
      const approved = await approveChannelPairingCode({ channel, code });
      if (!approved) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid pairing code"));
        return;
      }
      if (notify) {
        const cfg = loadConfig();
        await notifyPairingApproved({ channelId: channel, id: approved.id, cfg });
      }
      respond(true, { channel, approved }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "channels.remove": async ({ params, respond }) => {
    if (!validateChannelsRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.remove params"),
      );
      return;
    }
    try {
      await channelsRemoveCommand(params as any, makeApiRuntime(), { hasFlags: true });
      respond(true, { ok: true, action: "channels.remove" }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "channels.login": async ({ params, respond }) => {
    if (!validateChannelsLoginParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.login params"),
      );
      return;
    }
    const channelInput = typeof (params as any)?.channel === "string" ? (params as any).channel.trim() : "";
    const availableChannels = listChatChannels().map((entry) => entry.id);
    if (!channelInput) {
      respond(
        false,
        { availableChannels },
        errorShape(ErrorCodes.INVALID_REQUEST, "channel is required"),
      );
      return;
    }
    let installedChannels = listChannelPlugins().map((plugin) => plugin.id);
    let pluginDiagnostics: unknown[] | undefined;
    let pluginDiscovery: { bundledDir?: string; candidates?: string[] } | undefined;
    if (installedChannels.length === 0) {
      try {
        const cfg = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
        const registry = loadOpenClawPlugins({ config: cfg, workspaceDir });
        installedChannels = registry.channels.map((entry) => entry.plugin.id);
        pluginDiagnostics = registry.diagnostics;
        const discovery = discoverOpenClawPlugins({ workspaceDir });
        pluginDiscovery = {
          bundledDir: resolveBundledPluginsDir(),
          candidates: discovery.candidates.map((c) => c.idHint),
        };
      } catch (err) {
        pluginDiagnostics = [{ level: "error", message: String(err) }];
        pluginDiscovery = { bundledDir: resolveBundledPluginsDir(), candidates: [] };
      }
    }
    if (!installedChannels.includes(channelInput)) {
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
      const catalogChannels = listChannelPluginCatalogEntries({ workspaceDir }).map((entry) => entry.id);
      if (pluginDiscovery?.candidates?.includes(channelInput)) {
        const allow = Array.isArray(cfg.plugins?.allow) ? cfg.plugins?.allow : undefined;
        const nextAllow = allow && !allow.includes(channelInput) ? [...allow, channelInput] : allow;
        const nextConfig = {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            ...(cfg.plugins?.enabled === false ? { enabled: true } : {}),
            ...(nextAllow ? { allow: nextAllow } : {}),
            entries: {
              ...cfg.plugins?.entries,
              [channelInput]: {
                ...(cfg.plugins?.entries?.[channelInput] ?? {}),
                enabled: true,
              },
            },
          },
        };
        await writeConfigFile(nextConfig);
        const registry = loadOpenClawPlugins({ config: nextConfig, workspaceDir });
        installedChannels = registry.channels.map((entry) => entry.plugin.id);
        pluginDiagnostics = registry.diagnostics;
      }
      if (!installedChannels.includes(channelInput)) {
        respond(
          false,
          { availableChannels, installedChannels, catalogChannels, pluginDiagnostics, pluginDiscovery },
          errorShape(ErrorCodes.INVALID_REQUEST, `channel plugin not installed: ${channelInput}`),
        );
        return;
      }
    }
    try {
      await runChannelLogin(params as any, makeApiRuntime());
      respond(true, { ok: true, action: "channels.login" }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "channels.status": async ({ params, respond, context }) => {
    if (!validateChannelsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.status params: ${formatValidationErrors(validateChannelsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const probe = (params as { probe?: boolean }).probe === true;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs = typeof timeoutMsRaw === "number" ? Math.max(1000, timeoutMsRaw) : 10_000;
    const cfg = loadConfig();
    const runtime = context.getRuntimeSnapshot();
    const plugins = listChannelPlugins();
    const pluginMap = new Map<ChannelId, ChannelPlugin>(
      plugins.map((plugin) => [plugin.id, plugin]),
    );

    const resolveRuntimeSnapshot = (
      channelId: ChannelId,
      accountId: string,
      defaultAccountId: string,
    ): ChannelAccountSnapshot | undefined => {
      const accounts = runtime.channelAccounts[channelId];
      const defaultRuntime = runtime.channels[channelId];
      const raw =
        accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntime : undefined);
      if (!raw) {
        return undefined;
      }
      return raw;
    };

    const isAccountEnabled = (plugin: ChannelPlugin, account: unknown) =>
      plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;

    const buildChannelAccounts = async (channelId: ChannelId) => {
      const plugin = pluginMap.get(channelId);
      if (!plugin) {
        return {
          accounts: [] as ChannelAccountSnapshot[],
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          defaultAccount: undefined as ChannelAccountSnapshot | undefined,
          resolvedAccounts: {} as Record<string, unknown>,
        };
      }
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: ChannelAccountSnapshot[] = [];
      const resolvedAccounts: Record<string, unknown> = {};
      for (const accountId of accountIds) {
        const account = plugin.config.resolveAccount(cfg, accountId);
        const enabled = isAccountEnabled(plugin, account);
        resolvedAccounts[accountId] = account;
        let probeResult: unknown;
        let lastProbeAt: number | null = null;
        if (probe && enabled && plugin.status?.probeAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            probeResult = await plugin.status.probeAccount({
              account,
              timeoutMs,
              cfg,
            });
            lastProbeAt = Date.now();
          }
        }
        let auditResult: unknown;
        if (probe && enabled && plugin.status?.auditAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            auditResult = await plugin.status.auditAccount({
              account,
              timeoutMs,
              cfg,
              probe: probeResult,
            });
          }
        }
        const runtimeSnapshot = resolveRuntimeSnapshot(channelId, accountId, defaultAccountId);
        const snapshot = await buildChannelAccountSnapshot({
          plugin,
          cfg,
          accountId,
          runtime: runtimeSnapshot,
          probe: probeResult,
          audit: auditResult,
        });
        if (lastProbeAt) {
          snapshot.lastProbeAt = lastProbeAt;
        }
        const activity = getChannelActivity({
          channel: channelId as never,
          accountId,
        });
        if (snapshot.lastInboundAt == null) {
          snapshot.lastInboundAt = activity.inboundAt;
        }
        if (snapshot.lastOutboundAt == null) {
          snapshot.lastOutboundAt = activity.outboundAt;
        }
        accounts.push(snapshot);
      }
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ?? accounts[0];
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const uiCatalog = buildChannelUiCatalog(plugins);
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      channelOrder: uiCatalog.order,
      channelLabels: uiCatalog.labels,
      channelDetailLabels: uiCatalog.detailLabels,
      channelSystemImages: uiCatalog.systemImages,
      channelMeta: uiCatalog.entries,
      channels: {} as Record<string, unknown>,
      channelAccounts: {} as Record<string, unknown>,
      channelDefaultAccountId: {} as Record<string, unknown>,
    };
    const channelsMap = payload.channels as Record<string, unknown>;
    const accountsMap = payload.channelAccounts as Record<string, unknown>;
    const defaultAccountIdMap = payload.channelDefaultAccountId as Record<string, unknown>;
    for (const plugin of plugins) {
      const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
        await buildChannelAccounts(plugin.id);
      const fallbackAccount =
        resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
      const summary = plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account: fallbackAccount,
            cfg,
            defaultAccountId,
            snapshot:
              defaultAccount ??
              ({
                accountId: defaultAccountId,
              } as ChannelAccountSnapshot),
          })
        : {
            configured: defaultAccount?.configured ?? false,
          };
      channelsMap[plugin.id] = summary;
      accountsMap[plugin.id] = accounts;
      defaultAccountIdMap[plugin.id] = defaultAccountId;
    }

    respond(true, payload, undefined);
  },
  "channels.logout": async ({ params, respond, context }) => {
    if (!validateChannelsLogoutParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.logout params: ${formatValidationErrors(validateChannelsLogoutParams.errors)}`,
        ),
      );
      return;
    }
    const rawChannel = (params as { channel?: unknown }).channel;
    const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
    if (!channelId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.logout channel"),
      );
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.gateway?.logoutAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support logout`),
      );
      return;
    }
    const accountIdRaw = (params as { accountId?: unknown }).accountId;
    const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : undefined;
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    try {
      const payload = await logoutChannelAccount({
        channelId,
        accountId,
        cfg: snapshot.config ?? {},
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

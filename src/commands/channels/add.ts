import type { ChannelId } from "../../channels/plugins/types.js";
import type { ChannelChoice } from "../onboard-types.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChannelPluginCatalogEntries } from "../../channels/plugins/catalog.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { writeConfigFile, type OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { setupChannels } from "../onboard-channels.js";
import {
  ensureOnboardingPluginInstalled,
  reloadOnboardingPluginRegistry,
} from "../onboarding/plugin-install.js";
import { applyAccountName, applyChannelAccountConfig } from "./add-mutators.js";
import { channelLabel, requireValidConfig, shouldUseWizard } from "./shared.js";

export type ChannelsAddOptions = {
  channel?: string;
  account?: string;
  name?: string;
  token?: string;
  tokenFile?: string;
  botToken?: string;
  appToken?: string;
  signalNumber?: string;
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
  authDir?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  webhookPath?: string;
  webhookUrl?: string;
  audienceType?: string;
  audience?: string;
  useEnv?: boolean;
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  initialSyncLimit?: number | string;
  ship?: string;
  url?: string;
  code?: string;
  selfChatMode?: boolean;
  groupChannels?: string;
  dmAllowlist?: string;
  dmPolicy?: string;
  groupPolicy?: string;
  allowFrom?: string;
  autoDiscoverChannels?: boolean;
  baseUrl?: string;
  secret?: string;
  secretFile?: string;
  webhookSecret?: string;
  profile?: string;
  appId?: string;
  appSecret?: string;
  appSecretFile?: string;
  domain?: string;
  channelAccessToken?: string;
  channelSecret?: string;
  [key: string]: unknown;
};

function parseList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function resolveCatalogChannelEntry(raw: string, cfg: OpenClawConfig | null) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  const workspaceDir = cfg ? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) : undefined;
  return listChannelPluginCatalogEntries({ workspaceDir }).find((entry) => {
    if (entry.id.toLowerCase() === trimmed) {
      return true;
    }
    return (entry.meta.aliases ?? []).some((alias) => alias.trim().toLowerCase() === trimmed);
  });
}

export async function channelsAddCommand(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }
  let nextConfig = cfg;

  const useWizard = shouldUseWizard(params);
  if (useWizard) {
    const prompter = createClackPrompter();
    let selection: ChannelChoice[] = [];
    const accountIds: Partial<Record<ChannelChoice, string>> = {};
    await prompter.intro("Channel setup");
    let nextConfig = await setupChannels(cfg, runtime, prompter, {
      allowDisable: false,
      allowSignalInstall: true,
      promptAccountIds: true,
      onSelection: (value) => {
        selection = value;
      },
      onAccountId: (channel, accountId) => {
        accountIds[channel] = accountId;
      },
    });
    if (selection.length === 0) {
      await prompter.outro("No channels selected.");
      return;
    }

    const wantsNames = await prompter.confirm({
      message: "Add display names for these accounts? (optional)",
      initialValue: false,
    });
    if (wantsNames) {
      for (const channel of selection) {
        const accountId = accountIds[channel] ?? DEFAULT_ACCOUNT_ID;
        const plugin = getChannelPlugin(channel);
        const account = plugin?.config.resolveAccount(nextConfig, accountId) as
          | { name?: string }
          | undefined;
        const snapshot = plugin?.config.describeAccount?.(account, nextConfig);
        const existingName = snapshot?.name ?? account?.name;
        const name = await prompter.text({
          message: `${channel} account name (${accountId})`,
          initialValue: existingName,
        });
        if (name?.trim()) {
          nextConfig = applyAccountName({
            cfg: nextConfig,
            channel,
            accountId,
            name,
          });
        }
      }
    }

    await writeConfigFile(nextConfig);
    await prompter.outro("Channels updated.");
    return;
  }

  const rawChannel = String(opts.channel ?? "");
  let channel = normalizeChannelId(rawChannel);
  let catalogEntry = channel ? undefined : resolveCatalogChannelEntry(rawChannel, nextConfig);

  if (!channel && catalogEntry) {
    const prompter = createClackPrompter();
    const workspaceDir = resolveAgentWorkspaceDir(nextConfig, resolveDefaultAgentId(nextConfig));
    const result = await ensureOnboardingPluginInstalled({
      cfg: nextConfig,
      entry: catalogEntry,
      prompter,
      runtime,
      workspaceDir,
    });
    nextConfig = result.cfg;
    if (!result.installed) {
      return;
    }
    reloadOnboardingPluginRegistry({ cfg: nextConfig, runtime, workspaceDir });
    channel = normalizeChannelId(catalogEntry.id) ?? (catalogEntry.id as ChannelId);
  }

  if (!channel) {
    const hint = catalogEntry
      ? `Plugin ${catalogEntry.meta.label} could not be loaded after install.`
      : `Unknown channel: ${String(opts.channel ?? "")}`;
    runtime.error(hint);
    runtime.exit(1);
    return;
  }

  const plugin = getChannelPlugin(channel);
  if (!plugin?.setup?.applyAccountConfig) {
    runtime.error(`Channel ${channel} does not support add.`);
    runtime.exit(1);
    return;
  }
  const accountId =
    plugin.setup.resolveAccountId?.({ cfg: nextConfig, accountId: opts.account }) ??
    normalizeAccountId(opts.account);
  const useEnv = opts.useEnv === true;
  const initialSyncLimit =
    typeof opts.initialSyncLimit === "number"
      ? opts.initialSyncLimit
      : typeof opts.initialSyncLimit === "string" && opts.initialSyncLimit.trim()
        ? Number.parseInt(opts.initialSyncLimit, 10)
        : undefined;
  const groupChannels = parseList(opts.groupChannels);
  const dmAllowlist = parseList(opts.dmAllowlist);
  const allowFrom = parseList(opts.allowFrom);
  const reservedInputKeys = new Set<string>([
    "channel",
    "account",
    "name",
    "token",
    "tokenFile",
    "botToken",
    "appToken",
    "signalNumber",
    "cliPath",
    "dbPath",
    "service",
    "region",
    "authDir",
    "httpUrl",
    "httpHost",
    "httpPort",
    "webhookPath",
    "webhookUrl",
    "audienceType",
    "audience",
    "useEnv",
    "homeserver",
    "userId",
    "accessToken",
    "password",
    "deviceName",
    "initialSyncLimit",
    "ship",
    "url",
    "code",
    "selfChatMode",
    "groupChannels",
    "dmAllowlist",
    "dmPolicy",
    "groupPolicy",
    "allowFrom",
    "autoDiscoverChannels",
    "baseUrl",
    "secret",
    "secretFile",
    "webhookSecret",
    "profile",
    "appId",
    "appSecret",
    "appSecretFile",
    "domain",
    "channelAccessToken",
    "channelSecret",
  ]);
  const extraInput = Object.fromEntries(
    Object.entries(opts).filter(([key, value]) => {
      if (reservedInputKeys.has(key)) {
        return false;
      }
      if (value === undefined || value === null) {
        return false;
      }
      if (typeof value === "string" && value.trim().length === 0) {
        return false;
      }
      return true;
    }),
  );
  const setupInput = {
    name: opts.name,
    token: opts.token,
    tokenFile: opts.tokenFile,
    botToken: opts.botToken,
    appToken: opts.appToken,
    signalNumber: opts.signalNumber,
    cliPath: opts.cliPath,
    dbPath: opts.dbPath,
    service: opts.service,
    region: opts.region,
    authDir: opts.authDir,
    httpUrl: opts.httpUrl,
    httpHost: opts.httpHost,
    httpPort: opts.httpPort,
    webhookPath: opts.webhookPath,
    webhookUrl: opts.webhookUrl,
    audienceType: opts.audienceType,
    audience: opts.audience,
    homeserver: opts.homeserver,
    userId: opts.userId,
    accessToken: opts.accessToken,
    password: opts.password,
    deviceName: opts.deviceName,
    initialSyncLimit,
    useEnv,
    ship: opts.ship,
    url: opts.url,
    code: opts.code,
    selfChatMode: opts.selfChatMode,
    groupChannels,
    dmAllowlist,
    groupPolicy: opts.groupPolicy,
    autoDiscoverChannels: opts.autoDiscoverChannels,
    baseUrl: opts.baseUrl,
    secret: opts.secret,
    secretFile: opts.secretFile,
    webhookSecret: opts.webhookSecret,
    profile: opts.profile,
    appId: opts.appId,
    appSecret: opts.appSecret,
    appSecretFile: opts.appSecretFile,
    domain: opts.domain,
    channelAccessToken: opts.channelAccessToken,
    channelSecret: opts.channelSecret,
    ...extraInput,
  };

  const validationError = plugin.setup.validateInput?.({
    cfg: nextConfig,
    accountId,
    input: setupInput,
  });
  if (validationError) {
    runtime.error(validationError);
    runtime.exit(1);
    return;
  }

  nextConfig = applyChannelAccountConfig({
    cfg: nextConfig,
    channel,
    accountId,
    name: opts.name,
    token: opts.token,
    tokenFile: opts.tokenFile,
    botToken: opts.botToken,
    appToken: opts.appToken,
    signalNumber: opts.signalNumber,
    cliPath: opts.cliPath,
    dbPath: opts.dbPath,
    service: opts.service,
    region: opts.region,
    authDir: opts.authDir,
    httpUrl: opts.httpUrl,
    httpHost: opts.httpHost,
    httpPort: opts.httpPort,
    webhookPath: opts.webhookPath,
    webhookUrl: opts.webhookUrl,
    audienceType: opts.audienceType,
    audience: opts.audience,
    homeserver: opts.homeserver,
    userId: opts.userId,
    accessToken: opts.accessToken,
    password: opts.password,
    deviceName: opts.deviceName,
    initialSyncLimit,
    useEnv,
    ship: opts.ship,
    url: opts.url,
    code: opts.code,
    selfChatMode: opts.selfChatMode,
    groupChannels,
    dmAllowlist,
    groupPolicy: opts.groupPolicy,
    autoDiscoverChannels: opts.autoDiscoverChannels,
    extraInput,
  });

  if (opts.dmPolicy || allowFrom) {
    const dmPolicy = opts.dmPolicy?.trim();
    const allowFromList = allowFrom;
    if (channel === "discord" || channel === "slack") {
      nextConfig = {
        ...nextConfig,
        channels: {
          ...nextConfig.channels,
          [channel]: {
            ...(nextConfig.channels as any)?.[channel],
            dm: {
              ...((nextConfig.channels as any)?.[channel]?.dm ?? {}),
              ...(dmPolicy ? { policy: dmPolicy } : {}),
              ...(allowFromList ? { allowFrom: allowFromList } : {}),
            },
          },
        },
      } as typeof nextConfig;
    } else {
      nextConfig = {
        ...nextConfig,
        channels: {
          ...nextConfig.channels,
          [channel]: {
            ...(nextConfig.channels as any)?.[channel],
            ...(dmPolicy ? { dmPolicy } : {}),
            ...(allowFromList ? { allowFrom: allowFromList } : {}),
          },
        },
      } as typeof nextConfig;
    }
  }

  if (opts.groupPolicy?.trim()) {
    const groupPolicy = opts.groupPolicy.trim();
    const accountKey = accountId || DEFAULT_ACCOUNT_ID;
    if (channel === "discord" || channel === "slack") {
      if (accountKey === DEFAULT_ACCOUNT_ID) {
        nextConfig = {
          ...nextConfig,
          channels: {
            ...nextConfig.channels,
            [channel]: {
              ...(nextConfig.channels as any)?.[channel],
              groupPolicy,
            },
          },
        } as typeof nextConfig;
      } else {
        nextConfig = {
          ...nextConfig,
          channels: {
            ...nextConfig.channels,
            [channel]: {
              ...(nextConfig.channels as any)?.[channel],
              accounts: {
                ...((nextConfig.channels as any)?.[channel]?.accounts ?? {}),
                [accountKey]: {
                  ...((nextConfig.channels as any)?.[channel]?.accounts?.[accountKey] ?? {}),
                  groupPolicy,
                },
              },
            },
          },
        } as typeof nextConfig;
      }
    } else {
      nextConfig = {
        ...nextConfig,
        channels: {
          ...nextConfig.channels,
          [channel]: {
            ...(nextConfig.channels as any)?.[channel],
            groupPolicy,
          },
        },
      } as typeof nextConfig;
    }
  }

  if (channel === "whatsapp" && typeof opts.selfChatMode === "boolean") {
    nextConfig = {
      ...nextConfig,
      channels: {
        ...nextConfig.channels,
        whatsapp: {
          ...(nextConfig.channels as any)?.whatsapp,
          selfChatMode: opts.selfChatMode,
        },
      },
    } as typeof nextConfig;
  }

  await writeConfigFile(nextConfig);
  runtime.log(`Added ${channelLabel(channel)} account "${accountId}".`);
}

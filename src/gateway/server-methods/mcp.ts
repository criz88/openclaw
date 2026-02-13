import {
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  writeConfigFile,
} from "../../config/config.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import {
  buildMarketProviderId,
  buildMcpSecretRef,
  buildSmitheryApiKeyRef,
  normalizeMcpProviderId,
  readMcpHubConfig,
  type McpHubConfig,
  type McpProviderConfigEntry,
  type McpProviderFieldValue,
  writeMcpHubConfig,
} from "../../mcp/config.js";
import { installMarketProvider } from "../../mcp/installer.js";
import { findMcpPresetByProviderId, findMcpPresetByPresetId, listMcpPresets } from "../../mcp/presets.js";
import { createSmitheryClient, resolveSmitheryRegistryBaseUrl } from "../../mcp/smithery-client.js";
import { deleteSecret, getSecret, hasSecret, setSecret } from "../../mcp/secret-store.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMcpMarketDetailParams,
  validateMcpMarketInstallParams,
  validateMcpMarketRefreshParams,
  validateMcpMarketSearchParams,
  validateMcpMarketUninstallParams,
  validateMcpPresetsListParams,
  validateMcpProvidersApplyParams,
  validateMcpProvidersSnapshotParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { listToolDefinitions } from "./tools.js";

type McpFieldError = {
  providerId: string;
  field: string;
  message: string;
};

type SnapshotMarketConfig = {
  registryBaseUrl: string;
  apiKeyConfigured: boolean;
  lastSyncAt?: string;
};

function resolveBaseHash(params: Record<string, unknown>): string | null {
  const raw = params?.baseHash;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function requireConfigBaseHash(
  params: Record<string, unknown>,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): { ok: true } | { ok: false; error: string } {
  if (!snapshot.exists) return { ok: true };
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    return {
      ok: false,
      error: "config base hash unavailable; re-run mcp.providers.snapshot and retry",
    };
  }
  const baseHash = resolveBaseHash(params);
  if (!baseHash) {
    return {
      ok: false,
      error: "config base hash required; re-run mcp.providers.snapshot and retry",
    };
  }
  if (baseHash !== snapshotHash) {
    return {
      ok: false,
      error: "config changed since last load; re-run mcp.providers.snapshot and retry",
    };
  }
  return { ok: true };
}

function asString(value: unknown): string {
  return String(value || "").trim();
}

function sanitizeFieldValues(input: unknown): Record<string, McpProviderFieldValue> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, McpProviderFieldValue> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const fieldKey = asString(key);
    if (!fieldKey) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[fieldKey] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildSnapshotRows(params: {
  providersConfig: Record<string, McpProviderConfigEntry>;
  toolDefinitions: ReturnType<typeof listToolDefinitions>;
}) {
  const toolCountByProviderId = new Map<string, number>();
  for (const definition of params.toolDefinitions) {
    if (definition.providerKind !== "mcp") continue;
    const providerId = normalizeMcpProviderId(definition.providerId);
    if (!providerId) continue;
    toolCountByProviderId.set(providerId, (toolCountByProviderId.get(providerId) || 0) + 1);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const [providerId, cfg] of Object.entries(params.providersConfig)) {
    const toolCount = toolCountByProviderId.get(providerId) || 0;
    const secretState: Record<string, boolean> = {};
    for (const [field, secretRef] of Object.entries(cfg.secretRefs || {})) {
      secretState[field] = hasSecret(secretRef);
    }
    rows.push({
      providerId,
      presetId: cfg.presetId || "",
      source: cfg.source,
      implementationSource: cfg.implementationSource || (cfg.source === "market" ? "smithery" : "official"),
      qualifiedName: cfg.qualifiedName || "",
      label: cfg.label || providerId,
      configured: true,
      enabled: cfg.enabled === true,
      available: cfg.enabled === true && toolCount > 0,
      toolCount,
      iconUrl: cfg.iconUrl || "",
      description: cfg.description || "",
      homepage: cfg.homepage || "",
      website: cfg.website || "",
      docsUrl: cfg.docsUrl || "",
      fields: cfg.fields || {},
      region: cfg.region || "",
      workspace: cfg.workspace || "",
      scopes: cfg.scopes || [],
      requiredSecrets: cfg.requiredSecrets || [],
      statusHints: cfg.statusHints || [],
      secretState,
      updatedAt: cfg.updatedAt || "",
      installedAt: cfg.installedAt || "",
    });
  }
  return rows.sort((a, b) =>
    String(a.label || a.providerId || "").localeCompare(String(b.label || b.providerId || "")),
  );
}

function splitRowsBySource(rows: Array<Record<string, unknown>>) {
  const builtinRows: Array<Record<string, unknown>> = [];
  const marketRows: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const source = asString((row as { source?: unknown }).source).toLowerCase();
    if (source === "market") {
      marketRows.push(row);
    } else {
      builtinRows.push(row);
    }
  }
  return { builtinRows, marketRows };
}

function resolveSnapshotMarketConfig(hub: McpHubConfig): SnapshotMarketConfig {
  const apiKeyRef = asString(hub.marketConfig.apiKeyRef);
  return {
    registryBaseUrl: resolveSmitheryRegistryBaseUrl(hub.marketConfig.registryBaseUrl),
    apiKeyConfigured: Boolean(apiKeyRef && hasSecret(apiKeyRef)),
    ...(asString(hub.marketConfig.lastSyncAt) ? { lastSyncAt: asString(hub.marketConfig.lastSyncAt) } : {}),
  };
}

function buildSnapshotPayload(params: {
  hub: McpHubConfig;
  toolDefinitions: ReturnType<typeof listToolDefinitions>;
  hash?: string;
}) {
  const providers = {
    ...params.hub.builtinProviders,
    ...params.hub.marketProviders,
  };
  const rows = buildSnapshotRows({
    providersConfig: providers,
    toolDefinitions: params.toolDefinitions,
  });
  const split = splitRowsBySource(rows);
  return {
    ok: true,
    hash: params.hash || "",
    builtinProviders: split.builtinRows,
    marketProviders: split.marketRows,
    marketConfig: resolveSnapshotMarketConfig(params.hub),
  };
}

function buildProviderApplyFieldErrors(
  providerId: string,
  message: string,
  field = "provider",
): McpFieldError[] {
  return [
    {
      providerId,
      field,
      message,
    },
  ];
}

function applyBuiltinSecretValues(params: {
  providerId: string;
  existingSecretRefs: Record<string, string>;
  secretValues?: Record<string, unknown>;
}) {
  const nextSecretRefs = { ...params.existingSecretRefs };
  const fieldErrors: McpFieldError[] = [];
  const rollbackEntries: Array<{ secretRef: string; previousValue: string | null }> = [];

  const rollback = () => {
    for (let idx = rollbackEntries.length - 1; idx >= 0; idx -= 1) {
      const entry = rollbackEntries[idx];
      if (!entry) continue;
      if (entry.previousValue && entry.previousValue.trim()) {
        setSecret(entry.secretRef, entry.previousValue);
        continue;
      }
      deleteSecret(entry.secretRef);
    }
  };

  for (const [fieldKeyRaw, rawValue] of Object.entries(params.secretValues || {})) {
    const fieldKey = asString(fieldKeyRaw);
    if (!fieldKey) continue;
    const existingSecretRef = nextSecretRefs[fieldKey];
    if (rawValue === null || asString(rawValue) === "") {
      if (existingSecretRef) {
        const previousValue = asString(getSecret(existingSecretRef) || "");
        const deleteResult = deleteSecret(existingSecretRef);
        if (!deleteResult.ok) {
          fieldErrors.push({
            providerId: params.providerId,
            field: fieldKey,
            message: deleteResult.error || "failed to delete secret",
          });
          rollback();
          return { nextSecretRefs, fieldErrors };
        }
        rollbackEntries.push({
          secretRef: existingSecretRef,
          previousValue: previousValue || null,
        });
        delete nextSecretRefs[fieldKey];
      }
      continue;
    }
    const secretRef = buildMcpSecretRef(params.providerId, fieldKey, "builtin");
    const previousValue = asString(getSecret(secretRef) || "");
    const writeResult = setSecret(secretRef, String(rawValue));
    if (!writeResult.ok) {
      fieldErrors.push({
        providerId: params.providerId,
        field: fieldKey,
        message: writeResult.error || "failed to write secret",
      });
      rollback();
      return { nextSecretRefs, fieldErrors };
    }
    rollbackEntries.push({
      secretRef,
      previousValue: previousValue || null,
    });
    nextSecretRefs[fieldKey] = secretRef;
  }
  return { nextSecretRefs, fieldErrors };
}

function resolveSmitheryApiKey(hub: McpHubConfig, params: Record<string, unknown>) {
  const marketConfig = { ...hub.marketConfig };
  const apiKeyParam = params.smitheryApiKey;
  if (apiKeyParam === null || (typeof apiKeyParam === "string" && !apiKeyParam.trim())) {
    const existingRef = asString(marketConfig.apiKeyRef);
    if (existingRef) {
      deleteSecret(existingRef);
    }
    delete marketConfig.apiKeyRef;
    return { marketConfig, apiKey: "" };
  }
  if (typeof apiKeyParam === "string" && apiKeyParam.trim()) {
    const ref = buildSmitheryApiKeyRef();
    const writeResult = setSecret(ref, apiKeyParam.trim());
    if (!writeResult.ok) {
      throw new Error(writeResult.error || "failed to write smithery api key");
    }
    marketConfig.apiKeyRef = ref;
  }
  const apiKeyRef = asString(marketConfig.apiKeyRef);
  const apiKey = apiKeyRef ? asString(getSecret(apiKeyRef) || "") : "";
  return { marketConfig, apiKey };
}

export const mcpHandlers: GatewayRequestHandlers = {
  "mcp.presets.list": ({ params, respond }) => {
    if (!validateMcpPresetsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.presets.list params: ${formatValidationErrors(validateMcpPresetsListParams.errors)}`,
        ),
      );
      return;
    }
    respond(true, { ok: true, presets: listMcpPresets() }, undefined);
  },

  "mcp.providers.snapshot": async ({ params, respond, context }) => {
    if (!validateMcpProvidersSnapshotParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.providers.snapshot params: ${formatValidationErrors(validateMcpProvidersSnapshotParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before reading MCP providers"),
      );
      return;
    }
    const hub = readMcpHubConfig(snapshot.config);
    const toolDefinitions = listToolDefinitions(context, snapshot.config);
    respond(
      true,
      buildSnapshotPayload({
        hub,
        toolDefinitions,
        hash: resolveConfigSnapshotHash(snapshot) || "",
      }),
      undefined,
    );
  },

  "mcp.providers.apply": async ({ params, respond, context }) => {
    if (!validateMcpProvidersApplyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.providers.apply params: ${formatValidationErrors(validateMcpProvidersApplyParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before applying MCP providers"),
      );
      return;
    }
    const hashCheck = requireConfigBaseHash(params, snapshot);
    if (!hashCheck.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, hashCheck.error));
      return;
    }

    const inputProviders = Array.isArray(params.providers) ? params.providers : [];
    const hub = readMcpHubConfig(snapshot.config);
    const nextBuiltinProviders = { ...hub.builtinProviders };
    const fieldErrors: McpFieldError[] = [];

    for (const rawProvider of inputProviders) {
      const providerId = normalizeMcpProviderId(asString(rawProvider.providerId));
      if (!providerId) {
        fieldErrors.push({
          providerId: "",
          field: "providerId",
          message: "providerId is required",
        });
        continue;
      }
      const preset =
        findMcpPresetByPresetId(asString(rawProvider.presetId)) || findMcpPresetByProviderId(providerId);
      if (!preset) {
        fieldErrors.push(
          ...buildProviderApplyFieldErrors(providerId, "unsupported MCP preset", "presetId"),
        );
        continue;
      }

      const configured = rawProvider.configured !== false;
      const previous = nextBuiltinProviders[providerId];
      if (!configured) {
        if (previous?.secretRefs) {
          for (const secretRef of Object.values(previous.secretRefs)) {
            deleteSecret(secretRef);
          }
        }
        delete nextBuiltinProviders[providerId];
        continue;
      }

      const nextEntry: McpProviderConfigEntry = {
        source: "builtin",
        presetId: preset.presetId,
        implementationSource: preset.implementationSource,
        enabled: rawProvider.enabled !== false,
        label: asString(rawProvider.label) || preset.label,
        description: preset.description,
        website: preset.website,
        docsUrl: preset.docsUrl,
        requiredSecrets: preset.requiredSecrets || [],
        statusHints: preset.statusHints || [],
        iconUrl: "",
        fields: sanitizeFieldValues(rawProvider.fields) || {},
        secretRefs: { ...(previous?.secretRefs || {}) },
        updatedAt: new Date().toISOString(),
      };

      const secretResult = applyBuiltinSecretValues({
        providerId,
        existingSecretRefs: nextEntry.secretRefs || {},
        secretValues:
          rawProvider.secretValues && typeof rawProvider.secretValues === "object" && !Array.isArray(rawProvider.secretValues)
            ? (rawProvider.secretValues as Record<string, unknown>)
            : undefined,
      });
      if (secretResult.fieldErrors.length > 0) {
        fieldErrors.push(...secretResult.fieldErrors);
      }
      nextEntry.secretRefs = secretResult.nextSecretRefs;
      if (Object.keys(nextEntry.secretRefs).length === 0) {
        delete nextEntry.secretRefs;
      }
      if (nextEntry.fields && Object.keys(nextEntry.fields).length === 0) {
        delete nextEntry.fields;
      }
      nextBuiltinProviders[providerId] = nextEntry;
    }

    if (fieldErrors.length > 0) {
      respond(
        false,
        { ok: false, fieldErrors },
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid MCP provider payload", {
          details: { fieldErrors },
        }),
      );
      return;
    }

    const nextHub: McpHubConfig = {
      version: 2,
      builtinProviders: nextBuiltinProviders,
      marketProviders: { ...hub.marketProviders },
      marketConfig: { ...hub.marketConfig },
    };
    const nextConfig = writeMcpHubConfig(snapshot.config, nextHub);
    await writeConfigFile(nextConfig);
    const restart = scheduleGatewaySigusr1Restart({
      delayMs: 1200,
      reason: "mcp.providers.apply",
    });
    const nextSnapshot = await readConfigFileSnapshot();
    const stableConfig = nextSnapshot.valid ? nextSnapshot.config : nextConfig;
    const stableHub = readMcpHubConfig(stableConfig);
    const toolDefinitions = listToolDefinitions(context, stableConfig);
    respond(
      true,
      {
        ...buildSnapshotPayload({
          hub: stableHub,
          toolDefinitions,
          hash: nextSnapshot.valid ? resolveConfigSnapshotHash(nextSnapshot) || "" : "",
        }),
        restartRequired: true,
        restart,
      },
      undefined,
    );
  },

  "mcp.market.search": async ({ params, respond }) => {
    if (!validateMcpMarketSearchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.market.search params: ${formatValidationErrors(validateMcpMarketSearchParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config"));
      return;
    }
    const hub = readMcpHubConfig(snapshot.config);
    const marketConfig = resolveSmitheryApiKey(hub, {});
    const registryBaseUrl = resolveSmitheryRegistryBaseUrl(
      asString((params as Record<string, unknown>).registryBaseUrl) || marketConfig.marketConfig.registryBaseUrl,
    );
    const client = createSmitheryClient({
      registryBaseUrl,
      apiKey: marketConfig.apiKey,
    });
    try {
      const result = await client.search({
        query: asString((params as Record<string, unknown>).query),
        page: Number((params as Record<string, unknown>).page || 1),
        pageSize: Number((params as Record<string, unknown>).pageSize || 20),
      });
      respond(
        true,
        {
          ok: true,
          registryBaseUrl,
          items: result.items,
          pagination: result.pagination,
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String((error as Error)?.message || error || "search failed")),
      );
    }
  },

  "mcp.market.detail": async ({ params, respond }) => {
    if (!validateMcpMarketDetailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.market.detail params: ${formatValidationErrors(validateMcpMarketDetailParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config"));
      return;
    }
    const hub = readMcpHubConfig(snapshot.config);
    const marketConfig = resolveSmitheryApiKey(hub, {});
    const registryBaseUrl = resolveSmitheryRegistryBaseUrl(
      asString((params as Record<string, unknown>).registryBaseUrl) || marketConfig.marketConfig.registryBaseUrl,
    );
    const qualifiedName = asString((params as Record<string, unknown>).qualifiedName);
    const client = createSmitheryClient({
      registryBaseUrl,
      apiKey: marketConfig.apiKey,
    });
    try {
      const detail = await client.detail(qualifiedName);
      respond(true, { ok: true, registryBaseUrl, detail }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String((error as Error)?.message || error || "detail failed")),
      );
    }
  },

  "mcp.market.install": async ({ params, respond, context }) => {
    if (!validateMcpMarketInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.market.install params: ${formatValidationErrors(validateMcpMarketInstallParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config"));
      return;
    }
    const hashCheck = requireConfigBaseHash(params, snapshot);
    if (!hashCheck.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, hashCheck.error));
      return;
    }
    const hub = readMcpHubConfig(snapshot.config);
    let marketConfig = { ...hub.marketConfig };
    let smitheryApiKey = "";
    try {
      const apiResolve = resolveSmitheryApiKey(hub, params);
      marketConfig = apiResolve.marketConfig;
      smitheryApiKey = apiResolve.apiKey;
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String((error as Error)?.message || error || "api key failed")),
      );
      return;
    }

    const qualifiedName = asString((params as Record<string, unknown>).qualifiedName);
    const providerId = normalizeMcpProviderId(
      asString((params as Record<string, unknown>).providerId) || buildMarketProviderId(qualifiedName),
    );
    if (!providerId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "providerId is required"));
      return;
    }

    const registryBaseUrl = resolveSmitheryRegistryBaseUrl(
      asString((params as Record<string, unknown>).registryBaseUrl) || marketConfig.registryBaseUrl,
    );
    marketConfig.registryBaseUrl = registryBaseUrl;
    const client = createSmitheryClient({
      registryBaseUrl,
      apiKey: smitheryApiKey,
    });
    try {
      const metadata = await client.fetchInstallMetadata(qualifiedName);
      const install = await installMarketProvider({
        metadata,
        input: {
          providerId,
          enabled: (params as Record<string, unknown>).enabled !== false,
          implementationSource: "smithery",
          label: asString((params as Record<string, unknown>).label),
          fields:
            (params as Record<string, unknown>).fields &&
            typeof (params as Record<string, unknown>).fields === "object" &&
            !Array.isArray((params as Record<string, unknown>).fields)
              ? ((params as Record<string, unknown>).fields as Record<string, McpProviderFieldValue>)
              : undefined,
          secretValues:
            (params as Record<string, unknown>).secretValues &&
            typeof (params as Record<string, unknown>).secretValues === "object" &&
            !Array.isArray((params as Record<string, unknown>).secretValues)
              ? ((params as Record<string, unknown>).secretValues as Record<string, string | null>)
              : undefined,
          existing: hub.marketProviders[providerId],
          timeoutMs: Number((params as Record<string, unknown>).timeoutMs || 15000),
        },
      });
      if (!install.ok || !install.entry) {
        const fieldErrors = (install.fieldErrors || []).map((entry) => ({
          providerId,
          field: entry.field,
          message: entry.message,
        }));
        respond(
          false,
          { ok: false, fieldErrors },
          errorShape(ErrorCodes.INVALID_REQUEST, install.error || "install failed", {
            details: { fieldErrors },
          }),
        );
        return;
      }
      const nextHub: McpHubConfig = {
        version: 2,
        builtinProviders: { ...hub.builtinProviders },
        marketProviders: {
          ...hub.marketProviders,
          [providerId]: install.entry,
        },
        marketConfig: {
          ...marketConfig,
          lastSyncAt: new Date().toISOString(),
        },
      };
      const nextConfig = writeMcpHubConfig(snapshot.config, nextHub);
      await writeConfigFile(nextConfig);
      const restart = scheduleGatewaySigusr1Restart({
        delayMs: 1200,
        reason: "mcp.market.install",
      });
      const nextSnapshot = await readConfigFileSnapshot();
      const stableConfig = nextSnapshot.valid ? nextSnapshot.config : nextConfig;
      const stableHub = readMcpHubConfig(stableConfig);
      const toolDefinitions = listToolDefinitions(context, stableConfig);
      respond(
        true,
        {
          ...buildSnapshotPayload({
            hub: stableHub,
            toolDefinitions,
            hash: nextSnapshot.valid ? resolveConfigSnapshotHash(nextSnapshot) || "" : "",
          }),
          install: {
            providerId,
            qualifiedName,
            preflight: install.preflight || null,
          },
          restartRequired: true,
          restart,
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String((error as Error)?.message || error || "install failed")),
      );
    }
  },

  "mcp.market.uninstall": async ({ params, respond, context }) => {
    if (!validateMcpMarketUninstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.market.uninstall params: ${formatValidationErrors(validateMcpMarketUninstallParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config"));
      return;
    }
    const hashCheck = requireConfigBaseHash(params, snapshot);
    if (!hashCheck.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, hashCheck.error));
      return;
    }
    const hub = readMcpHubConfig(snapshot.config);
    const providerId = normalizeMcpProviderId(asString((params as Record<string, unknown>).providerId));
    const existing = hub.marketProviders[providerId];
    if (!existing) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "market provider not found"));
      return;
    }
    for (const secretRef of Object.values(existing.secretRefs || {})) {
      deleteSecret(secretRef);
    }
    const nextMarketProviders = { ...hub.marketProviders };
    delete nextMarketProviders[providerId];
    const nextHub: McpHubConfig = {
      version: 2,
      builtinProviders: { ...hub.builtinProviders },
      marketProviders: nextMarketProviders,
      marketConfig: { ...hub.marketConfig, lastSyncAt: new Date().toISOString() },
    };
    const nextConfig = writeMcpHubConfig(snapshot.config, nextHub);
    await writeConfigFile(nextConfig);
    const restart = scheduleGatewaySigusr1Restart({
      delayMs: 1200,
      reason: "mcp.market.uninstall",
    });
    const nextSnapshot = await readConfigFileSnapshot();
    const stableConfig = nextSnapshot.valid ? nextSnapshot.config : nextConfig;
    const stableHub = readMcpHubConfig(stableConfig);
    const toolDefinitions = listToolDefinitions(context, stableConfig);
    respond(
      true,
      {
        ...buildSnapshotPayload({
          hub: stableHub,
          toolDefinitions,
          hash: nextSnapshot.valid ? resolveConfigSnapshotHash(nextSnapshot) || "" : "",
        }),
        restartRequired: true,
        restart,
      },
      undefined,
    );
  },

  "mcp.market.refresh": async ({ params, respond, context }) => {
    if (!validateMcpMarketRefreshParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.market.refresh params: ${formatValidationErrors(validateMcpMarketRefreshParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config"));
      return;
    }
    const hashCheck = requireConfigBaseHash(params, snapshot);
    if (!hashCheck.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, hashCheck.error));
      return;
    }
    const hub = readMcpHubConfig(snapshot.config);
    let marketConfig = { ...hub.marketConfig };
    let smitheryApiKey = "";
    try {
      const apiResolve = resolveSmitheryApiKey(hub, params);
      marketConfig = apiResolve.marketConfig;
      smitheryApiKey = apiResolve.apiKey;
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String((error as Error)?.message || error || "api key failed")),
      );
      return;
    }
    const registryBaseUrl = resolveSmitheryRegistryBaseUrl(
      asString((params as Record<string, unknown>).registryBaseUrl) || marketConfig.registryBaseUrl,
    );
    marketConfig.registryBaseUrl = registryBaseUrl;
    const client = createSmitheryClient({
      registryBaseUrl,
      apiKey: smitheryApiKey,
    });
    const nextMarketProviders = { ...hub.marketProviders };
    const warnings: string[] = [];
    for (const [providerId, entry] of Object.entries(nextMarketProviders)) {
      const qualifiedName = asString(entry.qualifiedName);
      if (!qualifiedName) continue;
      try {
        const detail = await client.fetchInstallMetadata(qualifiedName);
        nextMarketProviders[providerId] = {
          ...entry,
          label: asString(entry.label) || detail.displayName,
          description: detail.description,
          iconUrl: detail.iconUrl,
          homepage: detail.homepage,
          connection: detail.connection,
          tools: detail.tools.map((tool) => ({
            name: tool.name,
            command: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
          })),
          updatedAt: new Date().toISOString(),
        };
      } catch (error) {
        warnings.push(`${providerId}: ${String((error as Error)?.message || error || "refresh failed")}`);
      }
    }
    const nextHub: McpHubConfig = {
      version: 2,
      builtinProviders: { ...hub.builtinProviders },
      marketProviders: nextMarketProviders,
      marketConfig: {
        ...marketConfig,
        lastSyncAt: new Date().toISOString(),
      },
    };
    const nextConfig = writeMcpHubConfig(snapshot.config, nextHub);
    await writeConfigFile(nextConfig);
    const restart = scheduleGatewaySigusr1Restart({
      delayMs: 1200,
      reason: "mcp.market.refresh",
    });
    const nextSnapshot = await readConfigFileSnapshot();
    const stableConfig = nextSnapshot.valid ? nextSnapshot.config : nextConfig;
    const stableHub = readMcpHubConfig(stableConfig);
    const toolDefinitions = listToolDefinitions(context, stableConfig);
    respond(
      true,
      {
        ...buildSnapshotPayload({
          hub: stableHub,
          toolDefinitions,
          hash: nextSnapshot.valid ? resolveConfigSnapshotHash(nextSnapshot) || "" : "",
        }),
        restartRequired: true,
        restart,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      undefined,
    );
  },
};

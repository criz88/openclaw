import crypto from "node:crypto";
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
import { createSmitheryConnectClient, isSmitheryRunToolsDeploymentUrl } from "../../mcp/smithery-connect.js";
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
  apiKeyLength?: number;
  apiKeyFingerprint?: string;
  lastSyncAt?: string;
};

type McpProviderLifecycleStage = "installed" | "configured" | "available";

function buildSmitheryConnectMcpUrl(qualifiedName: string): string {
  const safe = asString(qualifiedName).replace(/^\/+|\/+$/g, "");
  if (!safe) {
    throw new Error("qualifiedName is required");
  }
  return `https://server.smithery.ai/${safe}`;
}

async function wrapSmitheryRunToolsConnection(params: {
  qualifiedName: string;
  displayName: string;
  smitheryApiKey: string;
  timeoutMs?: number;
  existingNamespace?: string;
  existingConnectionId?: string;
}): Promise<{
  deploymentUrl: string;
  fields: Record<string, McpProviderFieldValue>;
}> {
  const connect = createSmitheryConnectClient({
    apiKey: params.smitheryApiKey,
    ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
  });
  const existingNamespace = asString(params.existingNamespace);
  const existingConnectionId = asString(params.existingConnectionId);
  const connectionId = existingConnectionId || `openclaw-${asString(params.qualifiedName) || "mcp"}`;
  const mcpUrl = buildSmitheryConnectMcpUrl(params.qualifiedName);

  const isNamespaceAccessError = (error: unknown) => {
    const msg = String((error as Error)?.message || error || "");
    return (
      /Smithery API 404/i.test(msg) &&
      /(not[_-]?found|namespace not found|invalid credentials)/i.test(msg)
    );
  };

  const candidates: string[] = [];
  if (existingNamespace) candidates.push(existingNamespace);
  const listed = await connect.listNamespaces();
  for (const ns of listed.namespaces || []) {
    const name = asString((ns as any)?.name);
    if (name) candidates.push(name);
  }
  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
  if (uniqueCandidates.length === 0) {
    uniqueCandidates.push((await connect.createNamespace()).name);
  }

  let lastError: unknown = null;
  for (const namespace of uniqueCandidates) {
    try {
      const connection = await connect.upsertConnection({
        namespace,
        connectionId,
        mcpUrl,
        name: params.displayName,
      });
      const stableConnectionId = asString(connection.connectionId) || connectionId;
      return {
        deploymentUrl: connect.buildConnectMcpEndpoint({
          namespace,
          connectionId: stableConnectionId,
        }),
        fields: {
          _smitheryNamespace: namespace,
          _smitheryConnectionId: stableConnectionId,
          _smitheryMcpUrl: mcpUrl,
        },
      };
    } catch (error) {
      lastError = error;
      if (isNamespaceAccessError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("Failed to create Smithery Connect connection");
}

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

function resolveEntrySecrets(entry: McpProviderConfigEntry): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [fieldKey, secretRef] of Object.entries(entry.secretRefs || {})) {
    const value = asString(getSecret(secretRef) || "");
    if (!value) continue;
    secrets[fieldKey] = value;
  }
  return secrets;
}

function hasProviderAuthToken(
  entry: McpProviderConfigEntry,
  secrets: Record<string, string>,
  marketApiKey: string,
): boolean {
  if (entry.source !== "market") return true;
  const authType = asString(entry.connection?.authType).toLowerCase() || "bearer";
  if (authType === "none") return true;
  const token = asString(secrets.token) || asString(secrets.apiKey) || asString(secrets.authToken);
  if (token) return true;
  return Boolean(marketApiKey);
}

function isAuthSecretAlias(key: string): boolean {
  const normalized = asString(key).toLowerCase();
  return normalized === "token" || normalized === "apikey" || normalized === "authtoken";
}

function isProviderConfigured(entry: McpProviderConfigEntry, marketApiKey: string): boolean {
  const secrets = resolveEntrySecrets(entry);
  const requiredSecrets = Array.isArray(entry.requiredSecrets) ? entry.requiredSecrets : [];
  for (const raw of requiredSecrets) {
    const key = asString(raw);
    if (!key) continue;
    const direct = asString(secrets[key]);
    if (direct) continue;
    if (
      isAuthSecretAlias(key) &&
      (asString(secrets.token) || asString(secrets.apiKey) || asString(secrets.authToken) || asString(marketApiKey))
    ) {
      continue;
    }
    return false;
  }
  return hasProviderAuthToken(entry, secrets, marketApiKey);
}

function buildSnapshotRows(params: {
  providersConfig: Record<string, McpProviderConfigEntry>;
  toolDefinitions: ReturnType<typeof listToolDefinitions>;
  marketApiKey: string;
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
    const configured = isProviderConfigured(cfg, params.marketApiKey);
    const available = cfg.enabled === true && toolCount > 0;
    const lifecycleStage: McpProviderLifecycleStage = available
      ? "available"
      : configured
        ? "configured"
        : "installed";
    const secretState: Record<string, boolean> = {};
    const secretLengths: Record<string, number> = {};
    for (const [field, secretRef] of Object.entries(cfg.secretRefs || {})) {
      const value = getSecret(secretRef);
      const present = typeof value === "string" && value.length > 0;
      secretState[field] = present;
      if (present) {
        secretLengths[field] = value.length;
      }
    }
    rows.push({
      providerId,
      presetId: cfg.presetId || "",
      source: cfg.source,
      implementationSource: cfg.implementationSource || (cfg.source === "market" ? "smithery" : "official"),
      qualifiedName: cfg.qualifiedName || "",
      label: cfg.label || providerId,
      configured,
      enabled: cfg.enabled === true,
      available,
      lifecycleStage,
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
      secretLengths,
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
  const fallbackRef = buildSmitheryApiKeyRef();
  const secret = asString(getSecret(apiKeyRef || fallbackRef) || "");
  const apiKeyLength = secret ? secret.length : 0;
  const apiKeyFingerprint = secret
    ? crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12)
    : "";
  return {
    registryBaseUrl: resolveSmitheryRegistryBaseUrl(hub.marketConfig.registryBaseUrl),
    apiKeyConfigured: Boolean(hasSecret(apiKeyRef || fallbackRef)),
    ...(apiKeyLength ? { apiKeyLength } : {}),
    ...(apiKeyFingerprint ? { apiKeyFingerprint } : {}),
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
    marketApiKey: asString(
      getSecret(asString(params.hub.marketConfig.apiKeyRef) || buildSmitheryApiKeyRef()) || "",
    ),
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

type SmitheryApiKeyMutation =
  | { op: "set"; secretRef: string; value: string; previousValue: string | null }
  | { op: "delete"; secretRef: string; previousValue: string | null };

function normalizeBearerToken(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/^bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : raw;
}

function resolveSmitheryApiKey(hub: McpHubConfig, params: Record<string, unknown>) {
  const marketConfig = { ...hub.marketConfig };
  const apiKeyParam = params.smitheryApiKey;
  if (apiKeyParam === null || (typeof apiKeyParam === "string" && !apiKeyParam.trim())) {
    const existingRef = asString(marketConfig.apiKeyRef);
    delete marketConfig.apiKeyRef;
    return {
      marketConfig,
      apiKey: "",
      ...(existingRef
        ? {
            mutation: {
              op: "delete" as const,
              secretRef: existingRef,
              previousValue: asString(getSecret(existingRef) || "") || null,
            },
          }
        : {}),
    };
  }
  if (typeof apiKeyParam === "string" && apiKeyParam.trim()) {
    const nextValue = normalizeBearerToken(apiKeyParam);
    if (!nextValue) {
      throw new Error("smitheryApiKey is empty");
    }
    const ref = buildSmitheryApiKeyRef();
    marketConfig.apiKeyRef = ref;
    return {
      marketConfig,
      apiKey: nextValue,
      mutation: {
        op: "set" as const,
        secretRef: ref,
        value: nextValue,
        previousValue: asString(getSecret(ref) || "") || null,
      },
    };
  }
  const apiKeyRef = asString(marketConfig.apiKeyRef) || buildSmitheryApiKeyRef();
  const apiKey = normalizeBearerToken(getSecret(apiKeyRef) || "");
  return { marketConfig, apiKey, mutation: undefined };
}

function applySmitheryApiKeyMutation(mutation?: SmitheryApiKeyMutation): { ok: true } | { ok: false; error: string } {
  if (!mutation) return { ok: true };
  if (mutation.op === "set") {
    const writeResult = setSecret(mutation.secretRef, mutation.value);
    if (!writeResult.ok) {
      return { ok: false, error: writeResult.error || "failed to write smithery api key" };
    }
    return { ok: true };
  }
  const deleteResult = deleteSecret(mutation.secretRef);
  if (!deleteResult.ok) {
    return { ok: false, error: deleteResult.error || "failed to delete smithery api key" };
  }
  return { ok: true };
}

function rollbackSmitheryApiKeyMutation(mutation?: SmitheryApiKeyMutation) {
  if (!mutation) return;
  const previousValue = asString(mutation.previousValue || "");
  if (previousValue) {
    setSecret(mutation.secretRef, previousValue);
    return;
  }
  deleteSecret(mutation.secretRef);
}

function formatMcpMarketErrorMessage(error: unknown, fallback: string): string {
  const message = String((error as Error)?.message || error || fallback).trim();
  if (!message) return fallback;
  if (/(Smithery API 401)/i.test(message) && /(Invalid API key or session token)/i.test(message)) {
    return [
      "Smithery API key is invalid (401).",
      "Note: some Smithery endpoints (registry) may work without auth, but Smithery Connect requires a valid key.",
      "Verify with: GET https://api.smithery.ai/namespaces (Authorization: Bearer <key>).",
    ].join(" ");
  }
  if (/(invalid[_\s-]?token|\"error\"\\s*:\\s*\"invalid_token\"|invalid token)/i.test(message)) {
    return "MCP endpoint rejected the token (invalid_token). The key is being sent, but it is not valid for this provider.";
  }
  if (/(missing authorization header)/i.test(message)) {
    return "MCP endpoint requires Authorization header. Configure a valid token (no 'Bearer ' prefix) and try again.";
  }
  if (
    /(MCP HTTP 401|invalid[_\s-]?token|missing authorization header|unauthorized)/i.test(message)
  ) {
    return "This MCP requires a valid Smithery API key. Configure smitheryApiKey (token only, no 'Bearer ' prefix) and try again.";
  }
  if (
    message.includes("is not valid JSON") ||
    message.includes("Unexpected token")
  ) {
    return `MCP endpoint returned non-JSON response: ${message}`;
  }
  return message;
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
    const marketConfig = resolveSmitheryApiKey(hub, params as Record<string, unknown>);
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
        errorShape(ErrorCodes.INVALID_REQUEST, formatMcpMarketErrorMessage(error, "search failed")),
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
    const marketConfig = resolveSmitheryApiKey(hub, params as Record<string, unknown>);
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
        errorShape(ErrorCodes.INVALID_REQUEST, formatMcpMarketErrorMessage(error, "detail failed")),
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
    let apiResolve: ReturnType<typeof resolveSmitheryApiKey>;
    try {
      apiResolve = resolveSmitheryApiKey(hub, params);
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
    // Persist/clear the Smithery API key (secret-store) early so users can recover from a bad stored key
    // even if the install flow fails later (e.g. during Connect wrapping).
    const earlyMutationResult = applySmitheryApiKeyMutation(apiResolve.mutation);
    if (!earlyMutationResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, earlyMutationResult.error));
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
    if (findMcpPresetByProviderId(providerId) || hub.builtinProviders[providerId]) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `providerId is reserved by builtin MCP: ${providerId}`),
      );
      return;
    }
    const existingByProviderId = hub.marketProviders[providerId];
    if (
      existingByProviderId &&
      asString(existingByProviderId.qualifiedName) &&
      asString(existingByProviderId.qualifiedName) !== qualifiedName
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `providerId already exists with another MCP: ${providerId}`,
        ),
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
    try {
      const metadata = await client.fetchInstallMetadata(qualifiedName);
      // Smithery-hosted deployments (*.run.tools) are OAuth-protected resources; using the Connect MCP proxy
      // lets us authenticate with the Smithery API key instead of implementing the OAuth handshake.
      let extraFields: Record<string, McpProviderFieldValue> = {};
      if (smitheryApiKey && isSmitheryRunToolsDeploymentUrl(metadata.connection.deploymentUrl)) {
        const existingNamespace = asString(hub.marketProviders?.[providerId]?.fields?._smitheryNamespace);
        const existingConnectionId = asString(hub.marketProviders?.[providerId]?.fields?._smitheryConnectionId);
        const wrapped = await wrapSmitheryRunToolsConnection({
          qualifiedName,
          displayName: metadata.displayName,
          smitheryApiKey,
          timeoutMs: Number((params as Record<string, unknown>).timeoutMs || 15000),
          ...(existingNamespace ? { existingNamespace } : {}),
          ...(existingConnectionId ? { existingConnectionId } : {}),
        });
        metadata.connection.deploymentUrl = wrapped.deploymentUrl;
        metadata.connection.authType = "bearer";
        extraFields = wrapped.fields;
      }
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
              ? ({ ...((params as Record<string, unknown>).fields as Record<string, McpProviderFieldValue>), ...extraFields } as Record<
                  string,
                  McpProviderFieldValue
                >)
              : Object.keys(extraFields).length > 0
                ? extraFields
              : undefined,
          secretValues:
            (params as Record<string, unknown>).secretValues &&
            typeof (params as Record<string, unknown>).secretValues === "object" &&
            !Array.isArray((params as Record<string, unknown>).secretValues)
              ? ((params as Record<string, unknown>).secretValues as Record<string, string | null>)
              : undefined,
          ...(smitheryApiKey ? { marketApiKey: smitheryApiKey } : {}),
          existing: hub.marketProviders[providerId],
          timeoutMs: Number((params as Record<string, unknown>).timeoutMs || 15000),
          validateConnectivity: false,
        },
      });
      if (!install.ok || !install.entry) {
        const installError = formatMcpMarketErrorMessage(install.error || "install failed", "install failed");
        const fieldErrors = (install.fieldErrors || []).map((entry) => ({
          providerId,
          field: entry.field,
          message: entry.message,
        }));
        respond(
          false,
          { ok: false, fieldErrors },
          errorShape(ErrorCodes.INVALID_REQUEST, installError, {
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
      try {
        await writeConfigFile(nextConfig);
      } catch (error) {
        rollbackSmitheryApiKeyMutation(apiResolve.mutation);
        throw error;
      }
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
        errorShape(ErrorCodes.INVALID_REQUEST, formatMcpMarketErrorMessage(error, "install failed")),
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
    let apiResolve: ReturnType<typeof resolveSmitheryApiKey>;
    try {
      apiResolve = resolveSmitheryApiKey(hub, params);
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
    const earlyMutationResult = applySmitheryApiKeyMutation(apiResolve.mutation);
    if (!earlyMutationResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, earlyMutationResult.error));
      return;
    }
    try {
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
          let nextConnection = detail.connection;
          let nextFields: Record<string, McpProviderFieldValue> = { ...(entry.fields || {}) };
          if (isSmitheryRunToolsDeploymentUrl(detail.connection.deploymentUrl)) {
            if (asString(entry.fields?._smitheryNamespace) && asString(entry.fields?._smitheryConnectionId)) {
              const connect = createSmitheryConnectClient({ apiKey: smitheryApiKey });
              nextConnection = {
                ...detail.connection,
                deploymentUrl: connect.buildConnectMcpEndpoint({
                  namespace: asString(entry.fields?._smitheryNamespace),
                  connectionId: asString(entry.fields?._smitheryConnectionId),
                }),
                authType: "bearer",
              };
            } else if (smitheryApiKey) {
              const wrapped = await wrapSmitheryRunToolsConnection({
                qualifiedName,
                displayName: detail.displayName,
                smitheryApiKey,
                timeoutMs: 15_000,
                ...(asString(entry.fields?._smitheryNamespace)
                  ? { existingNamespace: asString(entry.fields?._smitheryNamespace) }
                  : {}),
                ...(asString(entry.fields?._smitheryConnectionId)
                  ? { existingConnectionId: asString(entry.fields?._smitheryConnectionId) }
                  : {}),
              });
              nextConnection = {
                ...detail.connection,
                deploymentUrl: wrapped.deploymentUrl,
                authType: "bearer",
              };
              nextFields = { ...nextFields, ...wrapped.fields };
            }
          }
          nextMarketProviders[providerId] = {
            ...entry,
            label: asString(entry.label) || detail.displayName,
            description: detail.description,
            iconUrl: detail.iconUrl,
            homepage: detail.homepage,
            connection: nextConnection,
            tools: detail.tools.map((tool) => ({
              name: tool.name,
              command: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
            })),
            fields: nextFields,
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
      try {
        await writeConfigFile(nextConfig);
      } catch (error) {
        rollbackSmitheryApiKeyMutation(apiResolve.mutation);
        throw error;
      }
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
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatMcpMarketErrorMessage(error, "refresh failed")),
      );
    }
  },
};

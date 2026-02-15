import type { GatewayRequestHandlers } from "./types.js";
import {
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  writeConfigFile,
} from "../../config/config.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import {
  buildMcpSecretRef,
  normalizeMcpProviderId,
  readMcpHubConfig,
  type McpHubConfig,
  type McpProviderConfigEntry,
  type McpProviderFieldValue,
  writeMcpHubConfig,
} from "../../mcp/config.js";
import { discoverMcpHttpTools } from "../../mcp/runtime.js";
import { deleteSecret, getSecret, hasSecret, setSecret } from "../../mcp/secret-store.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMcpProvidersApplyParams,
  validateMcpProvidersSnapshotParams,
} from "../protocol/index.js";
import { listToolDefinitions } from "./tools.js";

type McpFieldError = {
  providerId: string;
  field: string;
  message: string;
};

type McpPresetFieldOption = { value: string; label: string };

type McpPresetField = {
  key: string;
  label: string;
  description?: string;
  type: "text" | "number" | "boolean" | "select";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  options?: McpPresetFieldOption[];
  defaultValue?: string | number | boolean | null;
};

type McpPresetRow = {
  presetId: string;
  providerId: string;
  label: string;
  description?: string;
  iconKey?: string;
  implementationSource?: "official" | "trusted-substitute";
  statusHints?: string[];
  requiredSecrets?: string[];
  website?: string;
  docsUrl?: string;
  aliases?: string[];
  fields: McpPresetField[];
};

const DEFAULT_MCP_MARKET_REGISTRY_BASE_URL = "https://registry.smithery.ai";

function asString(value: unknown): string {
  return String(value || "").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input.map((item) => asString(item)).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function labelFromKey(key: string): string {
  const normalized = asString(key);
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  if (lower === "apikey") return "API Key";
  if (lower === "authtoken") return "Auth Token";
  if (lower === "token") return "Token";
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function sanitizePresetField(raw: unknown): McpPresetField | null {
  if (!isPlainObject(raw)) return null;
  const key = asString(raw.key);
  const label = asString(raw.label) || labelFromKey(key);
  const typeRaw = asString(raw.type).toLowerCase();
  const type: McpPresetField["type"] =
    typeRaw === "select" || typeRaw === "boolean" || typeRaw === "number"
      ? (typeRaw as any)
      : "text";

  const optionsRaw = Array.isArray(raw.options) ? (raw.options as unknown[]) : [];
  const options: McpPresetFieldOption[] = [];
  if (type === "select") {
    for (const item of optionsRaw) {
      if (!isPlainObject(item)) continue;
      const value = asString(item.value);
      const optLabel = asString(item.label);
      if (!value || !optLabel) continue;
      options.push({ value, label: optLabel });
    }
  }

  const description = asString(raw.description);
  const placeholder = asString(raw.placeholder);
  const defaultValue = raw.defaultValue as any;

  return {
    key,
    label,
    ...(description ? { description } : {}),
    type,
    ...(raw.required === true ? { required: true } : {}),
    ...(raw.secret === true ? { secret: true } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(raw.defaultValue !== undefined ? { defaultValue } : {}),
  };
}

function inferPresetId(providerId: string, presetId: string): string {
  const explicit = asString(presetId);
  if (explicit) return explicit;
  const normalized = asString(providerId);
  if (!normalized) return "";
  if (normalized.toLowerCase().startsWith("mcp:")) {
    return normalized.slice(4);
  }
  return normalized;
}

function buildPresetFieldsFromSecrets(requiredSecrets: string[] | undefined): McpPresetField[] {
  const keys = Array.isArray(requiredSecrets) ? requiredSecrets.map(asString).filter(Boolean) : [];
  const fields: McpPresetField[] = [];
  for (const key of keys) {
    fields.push({
      key,
      label: labelFromKey(key),
      type: "text",
      required: true,
      secret: true,
      placeholder: "",
    });
  }
  return fields;
}

function encodeQualifiedNamePath(qualifiedName: string): string {
  const normalized = asString(qualifiedName);
  if (!normalized) return "";
  // qualifiedName can contain slashes ("namespace/slug"); encode segments but preserve path structure.
  return normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function resolveRegistryBaseUrl(params: Record<string, unknown>): string {
  const raw = asString(params.registryBaseUrl);
  return raw || DEFAULT_MCP_MARKET_REGISTRY_BASE_URL;
}

function coercePositiveInt(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const coerced = Math.floor(input);
  return coerced > 0 ? coerced : fallback;
}

async function fetchRegistryJson(params: {
  url: URL;
  timeoutMs?: number;
}): Promise<{ ok: true; value: any } | { ok: false; error: string }> {
  try {
    const guarded = await fetchWithSsrFGuard({
      url: params.url.toString(),
      timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 10_000,
      init: {
        headers: {
          accept: "application/json",
        },
      },
    });
    try {
      if (!guarded.response.ok) {
        const snippet = await guarded.response.text().catch(() => "");
        return {
          ok: false,
          error: `registry request failed (${guarded.response.status}): ${snippet || guarded.response.statusText}`,
        };
      }
      const json = await guarded.response.json();
      return { ok: true, value: json };
    } finally {
      await guarded.release();
    }
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error)?.message || err || "registry request failed"),
    };
  }
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

function sanitizeConnection(input: unknown): McpProviderConfigEntry["connection"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const deploymentUrl = asString(raw.deploymentUrl);
  if (!deploymentUrl) return undefined;
  const authTypeRaw = asString(raw.authType).toLowerCase();
  const authType: "none" | "bearer" | undefined =
    authTypeRaw === "none" || authTypeRaw === "bearer" ? authTypeRaw : undefined;
  return {
    type: "http",
    deploymentUrl,
    ...(authType ? { authType } : {}),
  };
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

function isAuthSecretAlias(key: string): boolean {
  const normalized = asString(key).toLowerCase();
  return normalized === "token" || normalized === "apikey" || normalized === "authtoken";
}

function isProviderConfigured(entry: McpProviderConfigEntry): boolean {
  if (!asString(entry.connection?.deploymentUrl)) {
    return false;
  }
  const requiredSecrets = Array.isArray(entry.requiredSecrets) ? entry.requiredSecrets : [];
  const secrets = resolveEntrySecrets(entry);
  for (const raw of requiredSecrets) {
    const key = asString(raw);
    if (!key) continue;
    const direct = asString(secrets[key]);
    if (direct) continue;
    if (
      isAuthSecretAlias(key) &&
      (asString(secrets.token) || asString(secrets.apiKey) || asString(secrets.authToken))
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function resolveSecretState(entry: McpProviderConfigEntry): {
  secretState: Record<string, boolean>;
  secretLengths: Record<string, number>;
} {
  const secretState: Record<string, boolean> = {};
  const secretLengths: Record<string, number> = {};
  for (const [field, secretRef] of Object.entries(entry.secretRefs || {})) {
    const value = getSecret(secretRef);
    const present = typeof value === "string" && value.length > 0;
    secretState[field] = present;
    if (present) {
      secretLengths[field] = value.length;
    }
  }
  return { secretState, secretLengths };
}

function buildSnapshotPayload(params: {
  hub: McpHubConfig;
  toolDefinitions: ReturnType<typeof listToolDefinitions>;
  hash?: string;
}) {
  const toolCountByProviderId = new Map<string, number>();
  for (const definition of params.toolDefinitions) {
    if (definition.providerKind !== "mcp") continue;
    const providerId = normalizeMcpProviderId(definition.providerId);
    if (!providerId) continue;
    toolCountByProviderId.set(providerId, (toolCountByProviderId.get(providerId) || 0) + 1);
  }

  const rows = Object.entries(params.hub.providers).map(([providerId, entry]) => {
    const toolCount = toolCountByProviderId.get(providerId) || 0;
    const configured = isProviderConfigured(entry);
    const available = entry.enabled === true && toolCount > 0;
    const { secretState, secretLengths } = resolveSecretState(entry);
    return {
      providerId,
      label: entry.label || providerId,
      configured,
      enabled: entry.enabled === true,
      available,
      toolCount,
      connection: entry.connection || undefined,
      iconUrl: entry.iconUrl || "",
      description: entry.description || "",
      homepage: entry.homepage || "",
      website: entry.website || "",
      docsUrl: entry.docsUrl || "",
      fields: entry.fields || {},
      region: entry.region || "",
      workspace: entry.workspace || "",
      scopes: entry.scopes || [],
      requiredSecrets: entry.requiredSecrets || [],
      statusHints: entry.statusHints || [],
      secretState,
      secretLengths,
      updatedAt: entry.updatedAt || "",
      installedAt: entry.installedAt || "",
    };
  });

  rows.sort((a, b) =>
    String(a.label || a.providerId || "").localeCompare(String(b.label || b.providerId || "")),
  );

  return {
    ok: true,
    hash: params.hash || "",
    providers: rows,
  };
}

function applySecretValues(params: {
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

    const secretRef = buildMcpSecretRef(params.providerId, fieldKey);
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

export const mcpHandlers: GatewayRequestHandlers = {
  "mcp.market.search": async ({ params, respond }) => {
    const base = resolveRegistryBaseUrl(params);
    let url: URL;
    try {
      url = new URL("/servers", base);
    } catch {
      respond(true, { ok: false, error: "invalid registryBaseUrl" }, undefined);
      return;
    }

    const query = asString(params.query);
    if (query) {
      url.searchParams.set("q", query);
    }
    url.searchParams.set("page", String(coercePositiveInt(params.page, 1)));
    url.searchParams.set("pageSize", String(coercePositiveInt(params.pageSize, 20)));

    const res = await fetchRegistryJson({ url });
    if (!res.ok) {
      respond(true, { ok: false, error: res.error }, undefined);
      return;
    }

    const serversRaw = (res.value as any)?.servers;
    const paginationRaw = (res.value as any)?.pagination;
    const servers = Array.isArray(serversRaw) ? serversRaw : [];
    const pagination = isPlainObject(paginationRaw) ? paginationRaw : {};

    const items = servers
      .map((item: any) => ({
        qualifiedName: asString(item?.qualifiedName),
        displayName: asString(item?.displayName) || asString(item?.qualifiedName),
        ...(asString(item?.description) ? { description: asString(item.description) } : {}),
        ...(asString(item?.iconUrl) ? { iconUrl: asString(item.iconUrl) } : {}),
      }))
      .filter((item: any) => item.qualifiedName && item.displayName);

    respond(
      true,
      {
        ok: true,
        items,
        pagination: {
          currentPage: coercePositiveInt((pagination as any).currentPage, 1),
          pageSize: coercePositiveInt((pagination as any).pageSize, items.length || 20),
          totalPages: coercePositiveInt((pagination as any).totalPages, 1),
          totalCount: coercePositiveInt((pagination as any).totalCount, items.length),
        },
        registryBaseUrl: base,
      },
      undefined,
    );
  },

  "mcp.market.detail": async ({ params, respond }) => {
    const qualifiedName = asString(params.qualifiedName);
    if (!qualifiedName) {
      respond(true, { ok: false, error: "qualifiedName is required" }, undefined);
      return;
    }

    const base = resolveRegistryBaseUrl(params);
    let url: URL;
    try {
      url = new URL(`/servers/${encodeQualifiedNamePath(qualifiedName)}`, base);
    } catch {
      respond(true, { ok: false, error: "invalid registryBaseUrl" }, undefined);
      return;
    }

    const res = await fetchRegistryJson({ url });
    if (!res.ok) {
      respond(true, { ok: false, error: res.error }, undefined);
      return;
    }

    const raw = res.value as any;
    const connectionsRaw = Array.isArray(raw?.connections) ? raw.connections : [];
    const connections = connectionsRaw
      .map((entry: any) => ({
        type: "http" as const,
        deploymentUrl: asString(entry?.deploymentUrl || entry?.url || raw?.deploymentUrl),
        ...(asString(entry?.authType) ? { authType: asString(entry.authType) } : {}),
        ...(isPlainObject(entry?.configSchema) ? { configSchema: entry.configSchema } : {}),
      }))
      .filter((conn: any) => Boolean(conn.deploymentUrl));

    respond(
      true,
      {
        ok: true,
        detail: {
          qualifiedName: asString(raw?.qualifiedName) || qualifiedName,
          displayName: asString(raw?.displayName) || qualifiedName,
          ...(asString(raw?.description) ? { description: asString(raw.description) } : {}),
          ...(asString(raw?.iconUrl) ? { iconUrl: asString(raw.iconUrl) } : {}),
          connections,
        },
        registryBaseUrl: base,
      },
      undefined,
    );
  },

  "mcp.presets.list": async ({ respond }) => {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before reading MCP presets"),
      );
      return;
    }

    const entry = snapshot.config.plugins?.entries?.["mcp-hub"];
    const rawConfig = isPlainObject(entry?.config)
      ? (entry?.config as Record<string, unknown>)
      : {};
    const builtinProviders = isPlainObject(rawConfig.builtinProviders)
      ? rawConfig.builtinProviders
      : null;
    const providers = isPlainObject(rawConfig.providers) ? rawConfig.providers : null;
    const sourceMap =
      builtinProviders && Object.keys(builtinProviders).length > 0
        ? (builtinProviders as Record<string, unknown>)
        : providers && Object.keys(providers).length > 0
          ? (providers as Record<string, unknown>)
          : {};

    const presets: McpPresetRow[] = [];
    for (const [providerIdRaw, rawValue] of Object.entries(sourceMap)) {
      const providerId = normalizeMcpProviderId(asString(providerIdRaw));
      if (!providerId) continue;
      if (!isPlainObject(rawValue)) continue;

      const presetId = inferPresetId(providerId, asString(rawValue.presetId));
      const label = asString(rawValue.label) || presetId || providerId;
      if (!presetId || !label) continue;

      const requiredSecrets = sanitizeStringArray(rawValue.requiredSecrets);
      const statusHints = sanitizeStringArray(rawValue.statusHints);
      const aliases = sanitizeStringArray(rawValue.aliases);
      const fieldsRaw = Array.isArray(rawValue.fields) ? (rawValue.fields as unknown[]) : null;
      const fields: McpPresetField[] = [];
      if (fieldsRaw) {
        for (const item of fieldsRaw) {
          const field = sanitizePresetField(item);
          if (!field?.key || !field?.label) continue;
          fields.push(field);
        }
      }
      if (fields.length === 0) {
        fields.push(...buildPresetFieldsFromSecrets(requiredSecrets));
      }

      const implementationRaw = asString(rawValue.implementationSource).toLowerCase();
      const implementationSource: McpPresetRow["implementationSource"] =
        implementationRaw === "trusted-substitute"
          ? "trusted-substitute"
          : implementationRaw === "official"
            ? "official"
            : "official";

      const description = asString(rawValue.description);
      const iconKey = asString(rawValue.iconKey) || presetId;
      const website = asString(rawValue.website);
      const docsUrl = asString(rawValue.docsUrl);

      presets.push({
        presetId,
        providerId,
        label,
        ...(description ? { description } : {}),
        ...(iconKey ? { iconKey } : {}),
        ...(implementationSource ? { implementationSource } : {}),
        ...(statusHints ? { statusHints } : {}),
        ...(requiredSecrets ? { requiredSecrets } : {}),
        ...(website ? { website } : {}),
        ...(docsUrl ? { docsUrl } : {}),
        ...(aliases ? { aliases } : {}),
        fields,
      });
    }

    presets.sort((a, b) => String(a.label || "").localeCompare(String(b.label || "")));
    respond(true, { ok: true, presets }, undefined);
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

    const hub = readMcpHubConfig(snapshot.config);
    const nextProviders: Record<string, McpProviderConfigEntry> = { ...hub.providers };
    const inputProviders = Array.isArray((params as any).providers)
      ? ((params as any).providers as any[])
      : [];

    const fieldErrors: McpFieldError[] = [];

    for (const rawProvider of inputProviders) {
      const providerId = normalizeMcpProviderId(asString(rawProvider?.providerId));
      if (!providerId) {
        fieldErrors.push({
          providerId: "",
          field: "providerId",
          message: "providerId is required",
        });
        continue;
      }

      const configured = rawProvider?.configured !== false;
      const previous = nextProviders[providerId];

      if (!configured) {
        if (previous?.secretRefs) {
          for (const secretRef of Object.values(previous.secretRefs)) {
            deleteSecret(secretRef);
          }
        }
        delete nextProviders[providerId];
        continue;
      }

      const nextEntry: McpProviderConfigEntry = {
        ...(previous || { enabled: true }),
        enabled: rawProvider?.enabled !== false,
        label: asString(rawProvider?.label) || previous?.label || providerId,
        ...(sanitizeFieldValues(rawProvider?.fields)
          ? { fields: sanitizeFieldValues(rawProvider?.fields) }
          : {}),
        ...(sanitizeConnection(rawProvider?.connection)
          ? { connection: sanitizeConnection(rawProvider?.connection) }
          : {}),
        ...(Array.isArray(rawProvider?.requiredSecrets)
          ? { requiredSecrets: rawProvider.requiredSecrets.map(asString).filter(Boolean) }
          : {}),
        ...(Array.isArray(rawProvider?.statusHints)
          ? { statusHints: rawProvider.statusHints.map(asString).filter(Boolean) }
          : {}),
        updatedAt: new Date().toISOString(),
        ...(previous?.installedAt ? {} : { installedAt: new Date().toISOString() }),
      };

      const secretResult = applySecretValues({
        providerId,
        existingSecretRefs: { ...(previous?.secretRefs || {}) },
        secretValues:
          rawProvider?.secretValues &&
          typeof rawProvider.secretValues === "object" &&
          !Array.isArray(rawProvider.secretValues)
            ? (rawProvider.secretValues as Record<string, unknown>)
            : undefined,
      });
      if (secretResult.fieldErrors.length > 0) {
        fieldErrors.push(...secretResult.fieldErrors);
        continue;
      }
      nextEntry.secretRefs = secretResult.nextSecretRefs;
      if (Object.keys(nextEntry.secretRefs || {}).length === 0) {
        delete nextEntry.secretRefs;
      }
      if (nextEntry.fields && Object.keys(nextEntry.fields).length === 0) {
        delete nextEntry.fields;
      }

      const discoverTools = rawProvider?.discoverTools === true;
      if (discoverTools) {
        try {
          const secrets = resolveEntrySecrets(nextEntry);
          const tools = await discoverMcpHttpTools({
            provider: nextEntry,
            secrets,
            timeoutMs:
              typeof rawProvider?.timeoutMs === "number" ? rawProvider.timeoutMs : undefined,
          });
          nextEntry.tools = tools;
        } catch (error) {
          fieldErrors.push({
            providerId,
            field: "connection.deploymentUrl",
            message: String((error as Error)?.message || error || "failed to discover tools"),
          });
          continue;
        }
      }

      nextProviders[providerId] = nextEntry;
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
      version: 3,
      providers: nextProviders,
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
};

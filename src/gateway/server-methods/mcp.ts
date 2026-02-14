import {
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  writeConfigFile,
} from "../../config/config.js";
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
import type { GatewayRequestHandlers } from "./types.js";
import { listToolDefinitions } from "./tools.js";

type McpFieldError = {
  providerId: string;
  field: string;
  message: string;
};

function asString(value: unknown): string {
  return String(value || "").trim();
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
    if (isAuthSecretAlias(key) && (asString(secrets.token) || asString(secrets.apiKey) || asString(secrets.authToken))) {
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

  rows.sort((a, b) => String(a.label || a.providerId || "").localeCompare(String(b.label || b.providerId || "")));

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
    const inputProviders = Array.isArray((params as any).providers) ? ((params as any).providers as any[]) : [];

    const fieldErrors: McpFieldError[] = [];

    for (const rawProvider of inputProviders) {
      const providerId = normalizeMcpProviderId(asString(rawProvider?.providerId));
      if (!providerId) {
        fieldErrors.push({ providerId: "", field: "providerId", message: "providerId is required" });
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
        ...(sanitizeFieldValues(rawProvider?.fields) ? { fields: sanitizeFieldValues(rawProvider?.fields) } : {}),
        ...(sanitizeConnection(rawProvider?.connection) ? { connection: sanitizeConnection(rawProvider?.connection) } : {}),
        ...(Array.isArray(rawProvider?.requiredSecrets) ? { requiredSecrets: rawProvider.requiredSecrets.map(asString).filter(Boolean) } : {}),
        ...(Array.isArray(rawProvider?.statusHints) ? { statusHints: rawProvider.statusHints.map(asString).filter(Boolean) } : {}),
        updatedAt: new Date().toISOString(),
        ...(previous?.installedAt ? {} : { installedAt: new Date().toISOString() }),
      };

      const secretResult = applySecretValues({
        providerId,
        existingSecretRefs: { ...(previous?.secretRefs || {}) },
        secretValues:
          rawProvider?.secretValues && typeof rawProvider.secretValues === "object" && !Array.isArray(rawProvider.secretValues)
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
            timeoutMs: typeof rawProvider?.timeoutMs === "number" ? rawProvider.timeoutMs : undefined,
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


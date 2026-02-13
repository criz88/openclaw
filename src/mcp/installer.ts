import type { McpProviderFieldValue, McpProviderConfigEntry, McpRuntimeToolRow } from "./config.js";
import { buildMcpSecretRef } from "./config.js";
import type { SmitheryInstallMetadata } from "./smithery-client.js";
import { deleteSecret, getSecret, setSecret } from "./secret-store.js";
import { discoverMcpHttpTools, preflightMcpHttpProvider } from "./runtime.js";

export type McpInstallFieldError = {
  field: string;
  message: string;
};

export type InstallMarketProviderInput = {
  providerId: string;
  enabled: boolean;
  implementationSource?: "official" | "trusted-substitute" | "smithery";
  label?: string;
  fields?: Record<string, McpProviderFieldValue>;
  secretValues?: Record<string, string | null>;
  existing?: McpProviderConfigEntry;
  timeoutMs?: number;
};

export type InstallMarketProviderResult = {
  ok: boolean;
  entry?: McpProviderConfigEntry;
  fieldErrors?: McpInstallFieldError[];
  preflight?: {
    toolCount: number;
    listedTools: string[];
    smokeTool?: string;
    deploymentUrl?: string;
  };
  error?: string;
};

type SecretWriteOutput = {
  secretRefs: Record<string, string>;
  rollbackEntries: Array<{ ref: string; previousValue: string | null }>;
  fieldErrors: McpInstallFieldError[];
};

const asString = (value: unknown) => String(value || "").trim();

function normalizeFields(input: unknown): Record<string, McpProviderFieldValue> | undefined {
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

function convertTools(input: SmitheryInstallMetadata["tools"]): McpRuntimeToolRow[] {
  return input
    .map((tool) => {
      const name = asString(tool.name);
      if (!name) return null;
      return {
        name,
        command: name,
        ...(asString(tool.description) ? { description: asString(tool.description) } : {}),
        ...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema } : {}),
      } as McpRuntimeToolRow;
    })
    .filter((item): item is McpRuntimeToolRow => Boolean(item));
}

function buildBaseMarketEntry(params: {
  providerId: string;
  metadata: SmitheryInstallMetadata;
  input: InstallMarketProviderInput;
}): McpProviderConfigEntry {
  const nowIso = new Date().toISOString();
  const base: McpProviderConfigEntry = {
    source: "market",
    enabled: params.input.enabled !== false,
    implementationSource: params.input.implementationSource || "smithery",
    label: asString(params.input.label) || params.metadata.displayName,
    qualifiedName: params.metadata.qualifiedName,
    description: params.metadata.description,
    iconUrl: params.metadata.iconUrl,
    homepage: params.metadata.homepage,
    connection: params.metadata.connection,
    tools: convertTools(params.metadata.tools),
    fields: {
      ...(params.input.existing?.fields || {}),
      ...(normalizeFields(params.input.fields) || {}),
      deploymentUrl: params.metadata.connection.deploymentUrl,
    },
    secretRefs: {
      ...(params.input.existing?.secretRefs || {}),
    },
    installedAt: params.input.existing?.installedAt || nowIso,
    updatedAt: nowIso,
  };
  if (!base.tools || base.tools.length === 0) {
    delete base.tools;
  }
  return base;
}

function applySecretValues(params: {
  providerId: string;
  source: "market";
  existingSecretRefs: Record<string, string>;
  secretValues?: Record<string, string | null>;
}): SecretWriteOutput {
  const secretRefs = { ...params.existingSecretRefs };
  const rollbackEntries: Array<{ ref: string; previousValue: string | null }> = [];
  const fieldErrors: McpInstallFieldError[] = [];
  const secretValues = params.secretValues || {};
  for (const [fieldKeyRaw, valueRaw] of Object.entries(secretValues)) {
    const fieldKey = asString(fieldKeyRaw);
    if (!fieldKey) continue;
    const existingRef = secretRefs[fieldKey];
    if (valueRaw === null || asString(valueRaw) === "") {
      if (existingRef) {
        const previousValue = getSecret(existingRef);
        const deleteResult = deleteSecret(existingRef);
        if (!deleteResult.ok) {
          fieldErrors.push({
            field: fieldKey,
            message: deleteResult.error || "failed to delete secret",
          });
          rollbackSecrets(rollbackEntries);
          return { secretRefs, rollbackEntries: [], fieldErrors };
        }
        rollbackEntries.push({ ref: existingRef, previousValue });
        delete secretRefs[fieldKey];
      }
      continue;
    }
    const secretRef = buildMcpSecretRef(params.providerId, fieldKey, params.source);
    const previousValue = getSecret(secretRef);
    const writeResult = setSecret(secretRef, String(valueRaw));
    if (!writeResult.ok) {
      fieldErrors.push({
        field: fieldKey,
        message: writeResult.error || "failed to write secret",
      });
      rollbackSecrets(rollbackEntries);
      return { secretRefs, rollbackEntries: [], fieldErrors };
    }
    rollbackEntries.push({ ref: secretRef, previousValue });
    secretRefs[fieldKey] = secretRef;
  }
  return { secretRefs, rollbackEntries, fieldErrors };
}

function rollbackSecrets(entries: Array<{ ref: string; previousValue: string | null }>) {
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    const entry = entries[idx];
    if (!entry) continue;
    if (entry.previousValue && entry.previousValue.trim()) {
      setSecret(entry.ref, entry.previousValue);
      continue;
    }
    deleteSecret(entry.ref);
  }
}

function resolveSecretsForPreflight(params: {
  secretRefs?: Record<string, string>;
  secretValues?: Record<string, string | null>;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [fieldKey, secretRef] of Object.entries(params.secretRefs || {})) {
    const pending = params.secretValues?.[fieldKey];
    if (typeof pending === "string" && pending.trim()) {
      out[fieldKey] = pending.trim();
      continue;
    }
    if (pending === null) {
      continue;
    }
    const stored = String(getSecret(secretRef) || "").trim();
    if (stored) {
      out[fieldKey] = stored;
    }
  }
  return out;
}

export async function installMarketProvider(params: {
  metadata: SmitheryInstallMetadata;
  input: InstallMarketProviderInput;
}): Promise<InstallMarketProviderResult> {
  const baseEntry = buildBaseMarketEntry({
    providerId: params.input.providerId,
    metadata: params.metadata,
    input: params.input,
  });
  const secretWrite = applySecretValues({
    providerId: params.input.providerId,
    source: "market",
    existingSecretRefs: baseEntry.secretRefs || {},
    secretValues: params.input.secretValues,
  });
  if (secretWrite.fieldErrors.length > 0) {
    rollbackSecrets(secretWrite.rollbackEntries);
    return {
      ok: false,
      fieldErrors: secretWrite.fieldErrors,
      error: "invalid secret payload",
    };
  }
  baseEntry.secretRefs = secretWrite.secretRefs;
  if (Object.keys(baseEntry.secretRefs).length === 0) {
    delete baseEntry.secretRefs;
  }

  const resolvedSecrets = resolveSecretsForPreflight({
    secretRefs: baseEntry.secretRefs,
    secretValues: params.input.secretValues,
  });

  const preflight = await preflightMcpHttpProvider({
    provider: baseEntry,
    secrets: resolvedSecrets,
    timeoutMs: params.input.timeoutMs,
  });

  if (!preflight.ok) {
    rollbackSecrets(secretWrite.rollbackEntries);
    return {
      ok: false,
      fieldErrors: [
        {
          field: "connection",
          message: preflight.error || "preflight failed",
        },
      ],
      error: preflight.error || "preflight failed",
    };
  }

  try {
    const discovered = await discoverMcpHttpTools({
      provider: baseEntry,
      secrets: resolvedSecrets,
      timeoutMs: params.input.timeoutMs,
    });
    if (discovered.length > 0) {
      baseEntry.tools = discovered;
    }
  } catch {
    // Keep metadata tools fallback when discovery fails after successful preflight.
  }

  return {
    ok: true,
    entry: baseEntry,
    preflight: {
      toolCount: preflight.toolCount,
      listedTools: preflight.listedTools,
      ...(preflight.smokeTool ? { smokeTool: preflight.smokeTool } : {}),
      ...(preflight.deploymentUrl ? { deploymentUrl: preflight.deploymentUrl } : {}),
    },
  };
}

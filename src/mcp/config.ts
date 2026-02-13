import type { OpenClawConfig } from "../config/config.js";

export type McpProviderFieldValue = string | number | boolean | null;

export type McpProviderConfigEntry = {
  presetId: string;
  enabled: boolean;
  label?: string;
  region?: string;
  workspace?: string;
  scopes?: string[];
  fields?: Record<string, McpProviderFieldValue>;
  secretRefs?: Record<string, string>;
  updatedAt?: string;
};

type McpHubConfig = {
  providers: Record<string, McpProviderConfigEntry>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function normalizeMcpProviderId(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const normalized = raw.includes(":") ? raw : `mcp:${raw}`;
  return normalized.toLowerCase();
}

export function readMcpHubConfig(config: OpenClawConfig): McpHubConfig {
  const entry = config.plugins?.entries?.["mcp-hub"];
  const raw = isPlainObject(entry?.config) ? entry.config : {};
  const rawProviders = isPlainObject(raw.providers) ? raw.providers : {};
  const providers: Record<string, McpProviderConfigEntry> = {};

  for (const [providerIdRaw, providerValue] of Object.entries(rawProviders)) {
    const providerId = normalizeMcpProviderId(providerIdRaw);
    if (!providerId || !isPlainObject(providerValue)) continue;
    const presetId = String(providerValue.presetId || "").trim();
    if (!presetId) continue;

    const enabled = providerValue.enabled !== false;
    const next: McpProviderConfigEntry = {
      presetId,
      enabled,
    };

    const label = String(providerValue.label || "").trim();
    if (label) next.label = label;

    const region = String(providerValue.region || "").trim();
    if (region) next.region = region;

    const workspace = String(providerValue.workspace || "").trim();
    if (workspace) next.workspace = workspace;

    if (Array.isArray(providerValue.scopes)) {
      const scopes = providerValue.scopes
        .map((scope) => String(scope || "").trim())
        .filter(Boolean);
      if (scopes.length > 0) {
        next.scopes = Array.from(new Set(scopes));
      }
    }

    if (isPlainObject(providerValue.fields)) {
      const fields: Record<string, McpProviderFieldValue> = {};
      for (const [key, value] of Object.entries(providerValue.fields)) {
        const normalizedKey = String(key || "").trim();
        if (!normalizedKey) continue;
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          fields[normalizedKey] = value;
        }
      }
      if (Object.keys(fields).length > 0) {
        next.fields = fields;
      }
    }

    if (isPlainObject(providerValue.secretRefs)) {
      const secretRefs: Record<string, string> = {};
      for (const [key, value] of Object.entries(providerValue.secretRefs)) {
        const normalizedKey = String(key || "").trim();
        const normalizedRef = String(value || "").trim();
        if (!normalizedKey || !normalizedRef) continue;
        secretRefs[normalizedKey] = normalizedRef;
      }
      if (Object.keys(secretRefs).length > 0) {
        next.secretRefs = secretRefs;
      }
    }

    const updatedAt = String(providerValue.updatedAt || "").trim();
    if (updatedAt) next.updatedAt = updatedAt;

    providers[providerId] = next;
  }

  return { providers };
}

export function writeMcpHubConfig(
  config: OpenClawConfig,
  nextProviders: Record<string, McpProviderConfigEntry>,
): OpenClawConfig {
  const plugins = config.plugins ? { ...config.plugins } : {};
  const entries = plugins.entries ? { ...plugins.entries } : {};
  const mcpHubEntry = entries["mcp-hub"] ? { ...entries["mcp-hub"] } : {};
  const providers: Record<string, McpProviderConfigEntry> = {};

  for (const [providerIdRaw, entry] of Object.entries(nextProviders)) {
    const providerId = normalizeMcpProviderId(providerIdRaw);
    if (!providerId) continue;
    providers[providerId] = {
      ...entry,
      presetId: String(entry.presetId || "").trim(),
      enabled: entry.enabled !== false,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.region ? { region: entry.region } : {}),
      ...(entry.workspace ? { workspace: entry.workspace } : {}),
      ...(entry.scopes && entry.scopes.length > 0 ? { scopes: [...entry.scopes] } : {}),
      ...(entry.fields && Object.keys(entry.fields).length > 0 ? { fields: { ...entry.fields } } : {}),
      ...(entry.secretRefs && Object.keys(entry.secretRefs).length > 0
        ? { secretRefs: { ...entry.secretRefs } }
        : {}),
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    };
  }

  mcpHubEntry.config = {
    ...(isPlainObject(mcpHubEntry.config) ? mcpHubEntry.config : {}),
    providers,
  };
  entries["mcp-hub"] = mcpHubEntry;
  plugins.entries = entries;

  return {
    ...config,
    plugins,
  };
}

export function buildMcpSecretRef(providerId: string, fieldKey: string): string {
  const normalizedProviderId = normalizeMcpProviderId(providerId).replace(/[^a-z0-9:_-]/gi, "_");
  const normalizedField = String(fieldKey || "").trim().replace(/[^a-z0-9:_-]/gi, "_");
  return `mcp:${normalizedProviderId}:${normalizedField}`;
}

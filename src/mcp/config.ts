import type { OpenClawConfig } from "../config/config.js";
import { listMcpPresetProviderIds } from "./presets.js";

export type McpProviderFieldValue = string | number | boolean | null;
export type McpProviderSource = "builtin" | "market";
export type McpImplementationSource = "official" | "trusted-substitute" | "smithery";

export type McpRuntimeToolRow = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  command?: string;
};

export type McpMarketConnection = {
  type: "http";
  deploymentUrl: string;
  authType?: "none" | "bearer";
  configSchema?: Record<string, unknown>;
};

export type McpProviderConfigEntry = {
  source: McpProviderSource;
  presetId?: string;
  qualifiedName?: string;
  implementationSource?: McpImplementationSource;
  enabled: boolean;
  label?: string;
  iconUrl?: string;
  description?: string;
  homepage?: string;
  website?: string;
  docsUrl?: string;
  region?: string;
  workspace?: string;
  scopes?: string[];
  fields?: Record<string, McpProviderFieldValue>;
  secretRefs?: Record<string, string>;
  requiredSecrets?: string[];
  statusHints?: string[];
  tools?: McpRuntimeToolRow[];
  connection?: McpMarketConnection;
  updatedAt?: string;
  installedAt?: string;
};

export type McpMarketConfig = {
  registryBaseUrl?: string;
  apiKeyRef?: string;
  lastSyncAt?: string;
};

export type McpHubConfig = {
  version: 2;
  builtinProviders: Record<string, McpProviderConfigEntry>;
  marketProviders: Record<string, McpProviderConfigEntry>;
  marketConfig: McpMarketConfig;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cleanString = (value: unknown) => String(value || "").trim();
const KNOWN_BUILTIN_PROVIDER_IDS = new Set(
  listMcpPresetProviderIds().map((providerId) => normalizeMcpProviderId(providerId)),
);
let didLogBuiltinProviderFilter = false;

export function normalizeMcpProviderId(input: string): string {
  const raw = cleanString(input);
  if (!raw) return "";
  const normalized = raw.includes(":") ? raw : `mcp:${raw}`;
  return normalized.toLowerCase();
}

function sanitizeFieldValues(input: unknown): Record<string, McpProviderFieldValue> | undefined {
  if (!isPlainObject(input)) return undefined;
  const fields: Record<string, McpProviderFieldValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = cleanString(key);
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
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function sanitizeSecretRefs(input: unknown): Record<string, string> | undefined {
  if (!isPlainObject(input)) return undefined;
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const fieldKey = cleanString(key);
    const secretRef = cleanString(value);
    if (!fieldKey || !secretRef) continue;
    refs[fieldKey] = secretRef;
  }
  return Object.keys(refs).length > 0 ? refs : undefined;
}

function sanitizeStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const values = input.map((item) => cleanString(item)).filter(Boolean);
  return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function sanitizeTools(input: unknown): McpRuntimeToolRow[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const tools: McpRuntimeToolRow[] = [];
  for (const raw of input) {
    if (!isPlainObject(raw)) continue;
    const name = cleanString(raw.name);
    if (!name) continue;
    const description = cleanString(raw.description);
    const command = cleanString(raw.command);
    const inputSchema = isPlainObject(raw.inputSchema) ? (raw.inputSchema as Record<string, unknown>) : undefined;
    tools.push({
      name,
      ...(description ? { description } : {}),
      ...(command ? { command } : {}),
      ...(inputSchema ? { inputSchema } : {}),
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function sanitizeConnection(input: unknown): McpMarketConnection | undefined {
  if (!isPlainObject(input)) return undefined;
  const type = cleanString(input.type).toLowerCase();
  if (type !== "http") return undefined;
  const deploymentUrl = cleanString(input.deploymentUrl);
  if (!deploymentUrl) return undefined;
  const authTypeRaw = cleanString(input.authType).toLowerCase();
  const authType: "none" | "bearer" | undefined =
    authTypeRaw === "none" || authTypeRaw === "bearer" ? authTypeRaw : undefined;
  const configSchema = isPlainObject(input.configSchema)
    ? (input.configSchema as Record<string, unknown>)
    : undefined;
  return {
    type: "http",
    deploymentUrl,
    ...(authType ? { authType } : {}),
    ...(configSchema ? { configSchema } : {}),
  };
}

function sanitizeProviderEntry(
  providerId: string,
  input: unknown,
  fallbackSource: McpProviderSource,
): McpProviderConfigEntry | null {
  if (!isPlainObject(input)) return null;
  const enabled = input.enabled !== false;
  const sourceRaw = cleanString(input.source).toLowerCase();
  const source: McpProviderSource =
    sourceRaw === "builtin" || sourceRaw === "market" ? sourceRaw : fallbackSource;
  const presetId = cleanString(input.presetId);
  const label = cleanString(input.label);
  const region = cleanString(input.region);
  const workspace = cleanString(input.workspace);
  const qualifiedName = cleanString(input.qualifiedName);
  const description = cleanString(input.description);
  const homepage = cleanString(input.homepage);
  const website = cleanString(input.website);
  const docsUrl = cleanString(input.docsUrl);
  const iconUrl = cleanString(input.iconUrl);
  const installedAt = cleanString(input.installedAt);
  const updatedAt = cleanString(input.updatedAt);
  const implementationSourceRaw = cleanString(input.implementationSource).toLowerCase();
  const implementationSource: McpImplementationSource | undefined =
    implementationSourceRaw === "official" ||
    implementationSourceRaw === "trusted-substitute" ||
    implementationSourceRaw === "smithery"
      ? implementationSourceRaw
      : undefined;

  const next: McpProviderConfigEntry = {
    source,
    enabled,
    ...(presetId ? { presetId } : {}),
    ...(qualifiedName ? { qualifiedName } : {}),
    ...(label ? { label } : {}),
    ...(region ? { region } : {}),
    ...(workspace ? { workspace } : {}),
    ...(description ? { description } : {}),
    ...(homepage ? { homepage } : {}),
    ...(website ? { website } : {}),
    ...(docsUrl ? { docsUrl } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(installedAt ? { installedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(implementationSource ? { implementationSource } : {}),
  };

  const scopes = sanitizeStringArray(input.scopes);
  if (scopes) next.scopes = scopes;
  const requiredSecrets = sanitizeStringArray(input.requiredSecrets);
  if (requiredSecrets) next.requiredSecrets = requiredSecrets;
  const statusHints = sanitizeStringArray(input.statusHints);
  if (statusHints) next.statusHints = statusHints;
  const fields = sanitizeFieldValues(input.fields);
  if (fields) next.fields = fields;
  const secretRefs = sanitizeSecretRefs(input.secretRefs);
  if (secretRefs) next.secretRefs = secretRefs;
  const tools = sanitizeTools(input.tools);
  if (tools) next.tools = tools;
  const connection = sanitizeConnection(input.connection);
  if (connection) next.connection = connection;

  if (!next.presetId && source === "builtin") {
    next.presetId = providerId.replace(/^mcp:/, "");
  }

  return next;
}

function sanitizeProviderMap(
  input: unknown,
  source: McpProviderSource,
): Record<string, McpProviderConfigEntry> {
  if (!isPlainObject(input)) return {};
  const providers: Record<string, McpProviderConfigEntry> = {};
  for (const [providerIdRaw, providerValue] of Object.entries(input)) {
    const providerId = normalizeMcpProviderId(providerIdRaw);
    if (!providerId) continue;
    const entry = sanitizeProviderEntry(providerId, providerValue, source);
    if (!entry) continue;
    providers[providerId] = entry;
  }
  return providers;
}

function filterBuiltinProvidersToKnownPresets(
  providers: Record<string, McpProviderConfigEntry>,
): {
  providers: Record<string, McpProviderConfigEntry>;
  droppedProviderIds: string[];
} {
  const filtered: Record<string, McpProviderConfigEntry> = {};
  const droppedProviderIds: string[] = [];
  for (const [providerId, entry] of Object.entries(providers)) {
    const normalizedProviderId = normalizeMcpProviderId(providerId);
    if (!normalizedProviderId || !KNOWN_BUILTIN_PROVIDER_IDS.has(normalizedProviderId)) {
      droppedProviderIds.push(providerId);
      continue;
    }
    filtered[normalizedProviderId] = entry;
  }
  return { providers: filtered, droppedProviderIds };
}

function sanitizeMarketConfig(input: unknown): McpMarketConfig {
  if (!isPlainObject(input)) return {};
  const registryBaseUrl = cleanString(input.registryBaseUrl);
  const apiKeyRef = cleanString(input.apiKeyRef);
  const lastSyncAt = cleanString(input.lastSyncAt);
  return {
    ...(registryBaseUrl ? { registryBaseUrl } : {}),
    ...(apiKeyRef ? { apiKeyRef } : {}),
    ...(lastSyncAt ? { lastSyncAt } : {}),
  };
}

export function readMcpHubConfig(config: OpenClawConfig): McpHubConfig {
  const entry = config.plugins?.entries?.["mcp-hub"];
  const raw = isPlainObject(entry?.config) ? entry.config : {};

  const version = Number(raw.version) === 2 ? 2 : 1;
  const parsedBuiltinProviders = sanitizeProviderMap(
    version === 2 ? raw.builtinProviders : raw.providers,
    "builtin",
  );
  const { providers: builtinProviders, droppedProviderIds } =
    filterBuiltinProvidersToKnownPresets(parsedBuiltinProviders);
  if (droppedProviderIds.length > 0 && !didLogBuiltinProviderFilter) {
    didLogBuiltinProviderFilter = true;
    console.info(
      `[mcp] filtered unsupported legacy built-in providers: ${droppedProviderIds.join(", ")}`,
    );
  }
  const marketProviders = sanitizeProviderMap(raw.marketProviders, "market");
  const marketConfig = sanitizeMarketConfig(raw.marketConfig);

  return {
    version: 2,
    builtinProviders,
    marketProviders,
    marketConfig,
  };
}

function cloneProviderEntries(
  input: Record<string, McpProviderConfigEntry>,
): Record<string, McpProviderConfigEntry> {
  const out: Record<string, McpProviderConfigEntry> = {};
  for (const [providerIdRaw, entry] of Object.entries(input)) {
    const providerId = normalizeMcpProviderId(providerIdRaw);
    if (!providerId || !entry) continue;
    out[providerId] = {
      ...entry,
      source: entry.source === "market" ? "market" : "builtin",
      enabled: entry.enabled !== false,
      ...(entry.scopes && entry.scopes.length > 0 ? { scopes: [...entry.scopes] } : {}),
      ...(entry.requiredSecrets && entry.requiredSecrets.length > 0
        ? { requiredSecrets: [...entry.requiredSecrets] }
        : {}),
      ...(entry.statusHints && entry.statusHints.length > 0 ? { statusHints: [...entry.statusHints] } : {}),
      ...(entry.fields ? { fields: { ...entry.fields } } : {}),
      ...(entry.secretRefs ? { secretRefs: { ...entry.secretRefs } } : {}),
      ...(entry.tools
        ? {
            tools: entry.tools.map((tool) => ({
              ...tool,
              ...(tool.inputSchema ? { inputSchema: { ...tool.inputSchema } } : {}),
            })),
          }
        : {}),
      ...(entry.connection
        ? {
            connection: {
              ...entry.connection,
              ...(entry.connection.configSchema ? { configSchema: { ...entry.connection.configSchema } } : {}),
            },
          }
        : {}),
    };
  }
  return out;
}

export function writeMcpHubConfig(
  config: OpenClawConfig,
  next:
    | McpHubConfig
    | {
        builtinProviders: Record<string, McpProviderConfigEntry>;
        marketProviders: Record<string, McpProviderConfigEntry>;
        marketConfig?: McpMarketConfig;
      }
    | Record<string, McpProviderConfigEntry>,
): OpenClawConfig {
  const plugins = config.plugins ? { ...config.plugins } : {};
  const entries = plugins.entries ? { ...plugins.entries } : {};
  const mcpHubEntry = entries["mcp-hub"] ? { ...entries["mcp-hub"] } : {};

  const asLegacyMap =
    !isPlainObject(next) ||
    (!("builtinProviders" in next) && !("marketProviders" in next) && !("version" in next));

  const builtinProviders = asLegacyMap
    ? cloneProviderEntries(next as Record<string, McpProviderConfigEntry>)
    : cloneProviderEntries((next as { builtinProviders?: Record<string, McpProviderConfigEntry> }).builtinProviders || {});
  const marketProviders = asLegacyMap
    ? {}
    : cloneProviderEntries((next as { marketProviders?: Record<string, McpProviderConfigEntry> }).marketProviders || {});
  const marketConfig = asLegacyMap
    ? {}
    : sanitizeMarketConfig((next as { marketConfig?: McpMarketConfig }).marketConfig || {});

  mcpHubEntry.config = {
    ...(isPlainObject(mcpHubEntry.config) ? mcpHubEntry.config : {}),
    version: 2,
    // Keep providers for one-cycle compatibility.
    providers: builtinProviders,
    builtinProviders,
    marketProviders,
    marketConfig,
  };
  // mcp-hub is the runtime owner for MCP presets and market installs.
  mcpHubEntry.enabled = true;
  entries["mcp-hub"] = mcpHubEntry;
  plugins.entries = entries;

  return {
    ...config,
    plugins,
  };
}

export function listAllMcpProviders(hub: McpHubConfig): Record<string, McpProviderConfigEntry> {
  return {
    ...hub.builtinProviders,
    ...hub.marketProviders,
  };
}

function sanitizeRefPart(input: string): string {
  return String(input || "")
    .trim()
    .replace(/[^a-z0-9:_-]/gi, "_")
    .toLowerCase();
}

export function buildMcpSecretRef(
  providerId: string,
  fieldKey: string,
  source: McpProviderSource | "smithery" = "builtin",
): string {
  const normalizedField = sanitizeRefPart(fieldKey);
  if (source === "smithery") {
    return `mcp:smithery:${normalizedField}`;
  }
  const normalizedProviderId = sanitizeRefPart(normalizeMcpProviderId(providerId));
  return `mcp:${source}:${normalizedProviderId}:${normalizedField}`;
}

export function buildSmitheryApiKeyRef(): string {
  return buildMcpSecretRef("smithery", "apiKey", "smithery");
}

export function buildMarketProviderId(qualifiedName: string): string {
  const normalized = cleanString(qualifiedName).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const safe = normalized || "provider";
  return normalizeMcpProviderId(`mcp:market:${safe}`);
}

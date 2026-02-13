type SmitheryServerSearchRow = {
  id: string;
  qualifiedName: string;
  namespace?: string;
  slug?: string;
  displayName: string;
  description?: string;
  iconUrl?: string;
  verified?: boolean;
  useCount?: number;
  remote?: boolean;
  isDeployed?: boolean;
  createdAt?: string;
  homepage?: string;
  owner?: string;
  score?: number | null;
};

type SmitheryPagination = {
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
};

export type SmitherySearchResult = {
  items: SmitheryServerSearchRow[];
  pagination: SmitheryPagination;
};

export type SmitheryServerConnection = {
  type: "http";
  deploymentUrl: string;
  configSchema?: Record<string, unknown>;
  authType: "none" | "bearer";
};

export type SmitheryServerTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type SmitheryServerDetail = {
  qualifiedName: string;
  displayName: string;
  description?: string;
  iconUrl?: string;
  remote?: boolean;
  homepage?: string;
  connections: SmitheryServerConnection[];
  tools: SmitheryServerTool[];
};

export type SmitheryInstallMetadata = {
  qualifiedName: string;
  displayName: string;
  description?: string;
  iconUrl?: string;
  homepage?: string;
  connection: SmitheryServerConnection;
  tools: SmitheryServerTool[];
};

const DEFAULT_REGISTRY_BASE_URL = "https://registry.smithery.ai";
const DEFAULT_TIMEOUT_MS = 15_000;

const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string => String(value || "").trim();

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function normalizeRegistryBaseUrl(value?: string): string {
  const raw = asString(value) || DEFAULT_REGISTRY_BASE_URL;
  return raw.replace(/\/+$/, "");
}

async function fetchJson(params: {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (params.apiKey) {
      headers.Authorization = `Bearer ${params.apiKey}`;
    }
    const response = await fetch(params.url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`Smithery ${response.status}: ${JSON.stringify(payload).slice(0, 400)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function parseSearch(payload: unknown): SmitherySearchResult {
  const root = asObject(payload);
  const serversRaw = Array.isArray(root.servers) ? root.servers : [];
  const items: SmitheryServerSearchRow[] = [];
  for (const rowRaw of serversRaw) {
    const row = asObject(rowRaw);
    const qualifiedName = asString(row.qualifiedName);
    const displayName = asString(row.displayName) || qualifiedName;
    if (!qualifiedName || !displayName) continue;
    items.push({
      id: asString(row.id),
      qualifiedName,
      ...(asString(row.namespace) ? { namespace: asString(row.namespace) } : {}),
      ...(asString(row.slug) ? { slug: asString(row.slug) } : {}),
      displayName,
      ...(asString(row.description) ? { description: asString(row.description) } : {}),
      ...(asString(row.iconUrl) ? { iconUrl: asString(row.iconUrl) } : {}),
      ...(asBoolean(row.verified) !== undefined ? { verified: asBoolean(row.verified) } : {}),
      ...(asNumber(row.useCount) !== undefined ? { useCount: asNumber(row.useCount) } : {}),
      ...(asBoolean(row.remote) !== undefined ? { remote: asBoolean(row.remote) } : {}),
      ...(asBoolean(row.isDeployed) !== undefined ? { isDeployed: asBoolean(row.isDeployed) } : {}),
      ...(asString(row.createdAt) ? { createdAt: asString(row.createdAt) } : {}),
      ...(asString(row.homepage) ? { homepage: asString(row.homepage) } : {}),
      ...(asString(row.owner) ? { owner: asString(row.owner) } : {}),
      ...(asNumber(row.score) !== undefined ? { score: asNumber(row.score) } : {}),
    });
  }
  const paginationRaw = asObject(root.pagination);
  const pagination: SmitheryPagination = {
    currentPage: asNumber(paginationRaw.currentPage) || 1,
    pageSize: asNumber(paginationRaw.pageSize) || items.length || 0,
    totalPages: asNumber(paginationRaw.totalPages) || 1,
    totalCount: asNumber(paginationRaw.totalCount) || items.length,
  };
  return { items, pagination };
}

function parseDetail(payload: unknown): SmitheryServerDetail {
  const root = asObject(payload);
  const qualifiedName = asString(root.qualifiedName);
  const displayName = asString(root.displayName) || qualifiedName;
  if (!qualifiedName || !displayName) {
    throw new Error("Invalid Smithery server detail payload");
  }

  const connectionsRaw = Array.isArray(root.connections) ? root.connections : [];
  const connections: SmitheryServerConnection[] = [];
  for (const connRaw of connectionsRaw) {
    const conn = asObject(connRaw);
    const type = asString(conn.type).toLowerCase();
    if (type !== "http") continue;
    const deploymentUrl = asString(conn.deploymentUrl);
    if (!deploymentUrl) continue;
    const authTypeRaw = asString(conn.authType).toLowerCase();
    const authType: "none" | "bearer" =
      authTypeRaw === "none" || authTypeRaw === "bearer" ? authTypeRaw : "bearer";
    connections.push({
      type: "http",
      deploymentUrl,
      authType,
      ...(asObject(conn.configSchema) && Object.keys(asObject(conn.configSchema)).length > 0
        ? { configSchema: asObject(conn.configSchema) }
        : {}),
    });
  }

  const toolsRaw = Array.isArray(root.tools) ? root.tools : [];
  const tools: SmitheryServerTool[] = [];
  for (const toolRaw of toolsRaw) {
    const tool = asObject(toolRaw);
    const name = asString(tool.name);
    if (!name) continue;
    tools.push({
      name,
      ...(asString(tool.description) ? { description: asString(tool.description) } : {}),
      ...(isPlainObject(tool.inputSchema) ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
    });
  }

  return {
    qualifiedName,
    displayName,
    ...(asString(root.description) ? { description: asString(root.description) } : {}),
    ...(asString(root.iconUrl) ? { iconUrl: asString(root.iconUrl) } : {}),
    ...(asBoolean(root.remote) !== undefined ? { remote: asBoolean(root.remote) } : {}),
    ...(asString(root.homepage) ? { homepage: asString(root.homepage) } : {}),
    connections,
    tools,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createSmitheryClient(params?: {
  registryBaseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}) {
  const registryBaseUrl = normalizeRegistryBaseUrl(params?.registryBaseUrl);
  const apiKey = asString(params?.apiKey);
  const timeoutMs = params?.timeoutMs;

  return {
    registryBaseUrl,
    async search(input?: { query?: string; page?: number; pageSize?: number }) {
      const query = asString(input?.query);
      const page = Math.max(1, Number(input?.page || 1));
      const pageSize = Math.max(1, Math.min(50, Number(input?.pageSize || 20)));
      const url = new URL(`${registryBaseUrl}/servers`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", String(pageSize));
      if (query) {
        url.searchParams.set("q", query);
      }
      const payload = await fetchJson({
        url: url.toString(),
        ...(apiKey ? { apiKey } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return parseSearch(payload);
    },
    async detail(qualifiedName: string): Promise<SmitheryServerDetail> {
      const target = asString(qualifiedName);
      if (!target) {
        throw new Error("qualifiedName is required");
      }
      const encoded = encodeURIComponent(target);
      const payload = await fetchJson({
        url: `${registryBaseUrl}/servers/${encoded}`,
        ...(apiKey ? { apiKey } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return parseDetail(payload);
    },
    async fetchInstallMetadata(qualifiedName: string): Promise<SmitheryInstallMetadata> {
      const detail = await this.detail(qualifiedName);
      const connection = detail.connections.find((item) => item.type === "http");
      if (!connection) {
        throw new Error("No supported HTTP connection in Smithery server metadata");
      }
      return {
        qualifiedName: detail.qualifiedName,
        displayName: detail.displayName,
        ...(detail.description ? { description: detail.description } : {}),
        ...(detail.iconUrl ? { iconUrl: detail.iconUrl } : {}),
        ...(detail.homepage ? { homepage: detail.homepage } : {}),
        connection,
        tools: detail.tools,
      };
    },
    async fetchConfigTemplate(qualifiedName: string) {
      const metadata = await this.fetchInstallMetadata(qualifiedName);
      return metadata.connection.configSchema || {};
    },
  };
}

export function resolveSmitheryRegistryBaseUrl(configValue?: string): string {
  return normalizeRegistryBaseUrl(configValue);
}

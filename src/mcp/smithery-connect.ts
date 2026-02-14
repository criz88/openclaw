type SmitheryNamespaceCreateResponse = {
  name: string;
  createdAt?: string;
};

type SmitheryNamespacesListResponse = {
  namespaces: Array<{ name: string; createdAt?: string }>;
  pagination?: { currentPage?: number; pageSize?: number; totalPages?: number; totalCount?: number };
};

type SmitheryConnectionUpsertResponse = {
  connectionId: string;
  name?: string | null;
  mcpUrl: string;
  createdAt?: string;
  status?: { state?: string };
  serverInfo?: Record<string, unknown> | null;
};

const DEFAULT_API_BASE_URL = "https://api.smithery.ai";
const DEFAULT_TIMEOUT_MS = 15_000;

const asString = (value: unknown) => String(value || "").trim();

function normalizeApiBaseUrl(value?: string) {
  const raw = asString(value) || DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, "");
}

async function fetchJson(params: {
  url: string;
  apiKey: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    };
    const hasBody = params.body !== undefined && params.body !== null;
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(params.url, {
      method: params.method || "GET",
      headers,
      ...(hasBody ? { body: JSON.stringify(params.body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const errorText = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error(`Smithery API ${response.status}: ${String(errorText || "request failed").slice(0, 600)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeConnectionId(input: string): string {
  const raw = asString(input).toLowerCase();
  if (!raw) return "";
  // Smithery connectionId is a URL path component; keep it conservative.
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64);
}

export function createSmitheryConnectClient(params: { apiKey: string; apiBaseUrl?: string; timeoutMs?: number }) {
  const apiBaseUrl = normalizeApiBaseUrl(params.apiBaseUrl);
  const apiKey = asString(params.apiKey);
  const timeoutMs = params.timeoutMs;
  if (!apiKey) {
    throw new Error("Smithery API key is required");
  }

  return {
    apiBaseUrl,
    async listNamespaces(): Promise<SmitheryNamespacesListResponse> {
      const payload = await fetchJson({
        url: `${apiBaseUrl}/namespaces`,
        apiKey,
        method: "GET",
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      const obj = payload as any;
      const namespacesRaw = Array.isArray(obj?.namespaces) ? obj.namespaces : [];
      const namespaces = namespacesRaw
        .map((item: any) => ({
          name: asString(item?.name),
          ...(asString(item?.createdAt) ? { createdAt: asString(item.createdAt) } : {}),
        }))
        .filter((item: any) => item.name);
      return {
        namespaces,
        ...(obj?.pagination ? { pagination: obj.pagination as any } : {}),
      };
    },
    async createNamespace(input?: { name?: string }): Promise<SmitheryNamespaceCreateResponse> {
      const desired = asString(input?.name);
      if (desired) {
        const url = `${apiBaseUrl}/namespaces/${encodeURIComponent(desired)}`;
        const payload = await fetchJson({
          url,
          apiKey,
          method: "PUT",
          body: {},
          ...(timeoutMs ? { timeoutMs } : {}),
        });
        const obj = payload as any;
        const name = asString(obj?.name) || desired;
        return { name, ...(asString(obj?.createdAt) ? { createdAt: asString(obj.createdAt) } : {}) };
      }
      const payload = await fetchJson({
        url: `${apiBaseUrl}/namespaces`,
        apiKey,
        method: "POST",
        body: {},
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      const obj = payload as any;
      const name = asString(obj?.name);
      if (!name) {
        throw new Error("Smithery namespaces.create returned invalid payload");
      }
      return { name, ...(asString(obj?.createdAt) ? { createdAt: asString(obj.createdAt) } : {}) };
    },

    async upsertConnection(input: {
      namespace: string;
      connectionId: string;
      mcpUrl: string;
      name?: string;
    }): Promise<SmitheryConnectionUpsertResponse> {
      const namespace = asString(input.namespace);
      const connectionId = sanitizeConnectionId(input.connectionId);
      const mcpUrl = asString(input.mcpUrl);
      if (!namespace) throw new Error("Smithery namespace is required");
      if (!connectionId) throw new Error("Smithery connectionId is required");
      if (!mcpUrl) throw new Error("Smithery mcpUrl is required");

      const payload = await fetchJson({
        url: `${apiBaseUrl}/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}`,
        apiKey,
        method: "PUT",
        body: {
          mcpUrl,
          ...(asString(input.name) ? { name: asString(input.name) } : {}),
        },
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      const obj = payload as any;
      const resolvedId = asString(obj?.connectionId) || connectionId;
      const resolvedUrl = asString(obj?.mcpUrl) || mcpUrl;
      if (!resolvedId || !resolvedUrl) {
        throw new Error("Smithery connect upsert returned invalid payload");
      }
      return {
        connectionId: resolvedId,
        mcpUrl: resolvedUrl,
        ...(obj?.name !== undefined ? { name: obj.name as any } : {}),
        ...(asString(obj?.createdAt) ? { createdAt: asString(obj.createdAt) } : {}),
        ...(obj?.status ? { status: obj.status as any } : {}),
        ...(obj?.serverInfo ? { serverInfo: obj.serverInfo as any } : {}),
      };
    },

    buildConnectMcpEndpoint(input: { namespace: string; connectionId: string }): string {
      const namespace = asString(input.namespace);
      const connectionId = sanitizeConnectionId(input.connectionId);
      if (!namespace || !connectionId) {
        throw new Error("namespace and connectionId are required");
      }
      return `${apiBaseUrl}/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}/mcp`;
    },
  };
}

export function isSmitheryRunToolsDeploymentUrl(url: string): boolean {
  const raw = asString(url);
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.endsWith(".run.tools");
  } catch {
    return false;
  }
}

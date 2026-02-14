import { createSign } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type {
  McpHubConfig,
  McpProviderConfigEntry,
  McpProviderFieldValue,
  McpRuntimeToolRow,
} from "./config.js";
import {
  buildSmitheryApiKeyRef,
  listAllMcpProviders,
  normalizeMcpProviderId,
  readMcpHubConfig,
} from "./config.js";
import { getSecret } from "./secret-store.js";

type ToolProviderKind = "mcp";

export type McpRuntimeToolDefinition = {
  name: string;
  providerId: string;
  providerKind: ToolProviderKind;
  providerLabel: string;
  description: string;
  inputSchema: Record<string, unknown>;
  command: string;
  source: "builtin" | "market";
  implementationSource: "official" | "trusted-substitute" | "smithery";
};

type McpRuntimeInvokeParams = {
  config: OpenClawConfig;
  providerId: string;
  command: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
};

type McpRuntimeContext = {
  providerId: string;
  providerLabel: string;
  entry: McpProviderConfigEntry;
  fields: Record<string, McpProviderFieldValue>;
  secrets: Record<string, string>;
};

type McpRuntimeToolSpec = {
  command: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: McpRuntimeContext, args: Record<string, unknown>) => Promise<unknown>;
};

type McpRuntimeProviderSpec = {
  providerId: string;
  providerLabel: string;
  implementationSource: "official" | "trusted-substitute";
  tools: McpRuntimeToolSpec[];
};

type McpJsonRpcResponse = {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type McpHttpPreflightResult = {
  ok: boolean;
  toolCount: number;
  listedTools: string[];
  smokeTool?: string;
  error?: string;
  deploymentUrl?: string;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const INITIALIZE_PROTOCOL_VERSION = "2024-11-05";

function toBase64Url(value: string | Buffer) {
  const base = Buffer.isBuffer(value) ? value.toString("base64") : Buffer.from(value).toString("base64");
  return base.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeBearerToken(value: unknown): string {
  const raw = asString(value);
  if (!raw) return "";
  const match = raw.match(/^bearer\s+(.+)$/i);
  return match ? asString(match[1]) : raw;
}

function asNumber(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).filter(Boolean);
  }
  const raw = asString(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensure(value: string, message: string): string {
  const next = String(value || "").trim();
  if (!next) {
    throw new Error(message);
  }
  return next;
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>) {
  const target = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

async function fetchJson(params: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}) {
  const timeoutMs = Math.max(1000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(params.headers || {}),
    };
    const hasBody = params.body !== undefined;
    const response = await fetch(params.url, {
      method: params.method || "GET",
      headers: hasBody ? { ...headers, "Content-Type": "application/json" } : headers,
      ...(hasBody ? { body: JSON.stringify(params.body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    const json = text
      ? (() => {
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        })()
      : {};
    if (!response.ok) {
      const details = typeof json === "object" && json ? JSON.stringify(json).slice(0, 500) : String(json);
      throw new Error(`HTTP ${response.status}: ${details}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function resolveProviderState(config: OpenClawConfig, providerIdRaw: string): McpRuntimeContext {
  const providerId = normalizeMcpProviderId(providerIdRaw);
  const hubConfig = readMcpHubConfig(config);
  const entry = listAllMcpProviders(hubConfig)[providerId];
  if (!entry) {
    throw new Error(`MCP provider not configured: ${providerId}`);
  }
  if (entry.enabled !== true) {
    throw new Error(`MCP provider disabled: ${providerId}`);
  }
  const secretRefs = entry.secretRefs || {};
  const secrets: Record<string, string> = {};
  for (const [fieldKey, ref] of Object.entries(secretRefs)) {
    const value = getSecret(ref);
    if (value) {
      secrets[fieldKey] = value;
    }
  }
  return {
    providerId,
    providerLabel: entry.label?.trim() || providerId,
    entry,
    fields: entry.fields || {},
    secrets,
  };
}

function resolveProviderSecrets(entry: McpProviderConfigEntry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [fieldKey, ref] of Object.entries(entry.secretRefs || {})) {
    const value = asString(getSecret(ref));
    if (!value) continue;
    out[fieldKey] = value;
  }
  return out;
}

function resolveMarketApiKey(hub: McpHubConfig): string {
  const configuredRef = asString(hub.marketConfig.apiKeyRef);
  if (configuredRef) {
    const configured = asString(getSecret(configuredRef));
    if (configured) return configured;
  }
  return asString(getSecret(buildSmitheryApiKeyRef()));
}

function withMarketAuthFallback(
  entry: McpProviderConfigEntry,
  secrets: Record<string, string>,
  marketApiKey: string,
): Record<string, string> {
  if (entry.source !== "market") return secrets;
  if (!marketApiKey) return secrets;
  if (asString(secrets.token) || asString(secrets.apiKey) || asString(secrets.authToken)) {
    return secrets;
  }
  return { ...secrets, apiKey: marketApiKey };
}

function isAuthSecretAlias(key: string) {
  const normalized = asString(key).toLowerCase();
  return normalized === "token" || normalized === "apikey" || normalized === "authtoken";
}

function hasRequiredSecrets(entry: McpProviderConfigEntry, secrets: Record<string, string>) {
  const requiredSecrets = Array.isArray(entry.requiredSecrets) ? entry.requiredSecrets : [];
  for (const key of requiredSecrets) {
    const fieldKey = asString(key);
    if (!fieldKey) continue;
    const direct = asString(secrets[fieldKey]);
    if (direct) {
      continue;
    }
    if (
      isAuthSecretAlias(fieldKey) &&
      (asString(secrets.token) || asString(secrets.apiKey) || asString(secrets.authToken))
    ) {
      continue;
    }
    if (!direct) {
      return false;
    }
  }

  if (entry.source === "market") {
    const authType = asString(entry.connection?.authType).toLowerCase();
    if (!authType || authType === "bearer") {
      const tokenCandidate =
        asString(secrets.token) || asString(secrets.apiKey) || asString(secrets.authToken);
      if (!tokenCandidate) {
        return false;
      }
    }
  }

  return true;
}

function githubBaseUrl(ctx: McpRuntimeContext) {
  const configured = asString(ctx.fields.apiBaseUrl);
  return configured || "https://api.github.com";
}

function githubHeaders(ctx: McpRuntimeContext) {
  const token = ensure(ctx.secrets.token || "", "GitHub token is required");
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "OpenClaw-MCPHub",
    Accept: "application/vnd.github+json",
  };
}

async function notionApiCall(
  ctx: McpRuntimeContext,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
) {
  const token = ensure(ctx.secrets.token || "", "Notion token is required");
  return await fetchJson({
    url: `https://api.notion.com${path}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
    },
    ...(body !== undefined ? { body } : {}),
  });
}

function resolveGoogleDriveTokenFromSecret(secretRaw: string): { token?: string; serviceAccount?: Record<string, unknown> } {
  const trimmed = secretRaw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const record = asObject(parsed);
      const accessToken = asString(record.access_token);
      if (accessToken) return { token: accessToken };
      const clientEmail = asString(record.client_email);
      const privateKey = asString(record.private_key).replace(/\\n/g, "\n");
      if (clientEmail && privateKey) {
        return {
          serviceAccount: {
            ...record,
            client_email: clientEmail,
            private_key: privateKey,
          },
        };
      }
    } catch {
      return {};
    }
  }
  return { token: trimmed };
}

async function exchangeServiceAccountToken(serviceAccount: Record<string, unknown>) {
  const clientEmail = ensure(asString(serviceAccount.client_email), "Google service account client_email is required");
  const privateKey = ensure(asString(serviceAccount.private_key), "Google service account private_key is required");
  const tokenUri = asString(serviceAccount.token_uri) || "https://oauth2.googleapis.com/token";
  const nowSec = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: tokenUri,
      iat: nowSec - 5,
      exp: nowSec + 3600,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  const assertion = `${signingInput}.${toBase64Url(signature)}`;
  const form = new URLSearchParams();
  form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  form.set("assertion", assertion);

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed: ${JSON.stringify(json).slice(0, 500)}`);
  }
  const accessToken = asString(json.access_token);
  if (!accessToken) {
    throw new Error("Google OAuth token exchange returned empty access token");
  }
  return accessToken;
}

async function resolveGoogleDriveAccessToken(ctx: McpRuntimeContext): Promise<string> {
  const raw = ensure(ctx.secrets.credentialsJson || "", "Google Drive credentials are required");
  const resolved = resolveGoogleDriveTokenFromSecret(raw);
  if (resolved.token) return resolved.token;
  if (resolved.serviceAccount) return await exchangeServiceAccountToken(resolved.serviceAccount);
  throw new Error("Unsupported Google Drive credentials format");
}

const MCP_RUNTIME_PROVIDERS: McpRuntimeProviderSpec[] = [
  {
    providerId: "mcp:github",
    providerLabel: "GitHub",
    implementationSource: "official",
    tools: [
      {
        command: "search_repositories",
        description: "Search GitHub repositories by query.",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string", description: "Search query." },
            perPage: { type: "number", default: 20 },
            page: { type: "number", default: 1 },
          },
          required: ["q"],
          additionalProperties: false,
        },
        run: async (ctx, args) => {
          const q = ensure(asString(args.q), "q is required");
          const perPage = Math.max(1, Math.min(100, asNumber(args.perPage, 20)));
          const page = Math.max(1, asNumber(args.page, 1));
          const payload = asObject(
            await fetchJson({
              url: buildUrl(githubBaseUrl(ctx), "/search/repositories", {
                q,
                per_page: perPage,
                page,
              }),
              headers: githubHeaders(ctx),
            }),
          );
          const items = Array.isArray(payload.items) ? payload.items : [];
          return {
            totalCount: asNumber(payload.total_count, items.length),
            items: items.slice(0, perPage).map((item) => {
              const row = asObject(item);
              return {
                fullName: asString(row.full_name),
                description: asString(row.description),
                url: asString(row.html_url),
                stars: asNumber(row.stargazers_count, 0),
                language: asString(row.language),
                updatedAt: asString(row.updated_at),
              };
            }),
          };
        },
      },
      {
        command: "get_repository",
        description: "Fetch repository metadata by owner/repo.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
          },
          required: ["owner", "repo"],
          additionalProperties: false,
        },
        run: async (ctx, args) => {
          const owner = ensure(asString(args.owner), "owner is required");
          const repo = ensure(asString(args.repo), "repo is required");
          const payload = asObject(
            await fetchJson({
              url: buildUrl(githubBaseUrl(ctx), `/repos/${owner}/${repo}`),
              headers: githubHeaders(ctx),
            }),
          );
          return {
            fullName: asString(payload.full_name),
            description: asString(payload.description),
            url: asString(payload.html_url),
            defaultBranch: asString(payload.default_branch),
            stars: asNumber(payload.stargazers_count, 0),
            forks: asNumber(payload.forks_count, 0),
            openIssues: asNumber(payload.open_issues_count, 0),
            pushedAt: asString(payload.pushed_at),
          };
        },
      },
    ],
  },
  {
    providerId: "mcp:figma",
    providerLabel: "Figma",
    implementationSource: "official",
    tools: [
      {
        command: "get_file",
        description: "Fetch a Figma file document by file key.",
        inputSchema: {
          type: "object",
          properties: {
            fileKey: { type: "string" },
          },
          required: ["fileKey"],
          additionalProperties: false,
        },
        run: async (ctx, args) => {
          const token = ensure(ctx.secrets.token || "", "Figma token is required");
          const fileKey = ensure(asString(args.fileKey), "fileKey is required");
          const payload = asObject(
            await fetchJson({
              url: `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}`,
              headers: {
                "X-Figma-Token": token,
              },
            }),
          );
          return {
            name: asString(payload.name),
            role: asString(payload.role),
            lastModified: asString(payload.lastModified),
            version: asString(payload.version),
            thumbnailUrl: asString(payload.thumbnailUrl),
            document: payload.document ?? {},
          };
        },
      },
      {
        command: "get_nodes",
        description: "Fetch selected nodes from a Figma file.",
        inputSchema: {
          type: "object",
          properties: {
            fileKey: { type: "string" },
            nodeIds: {
              oneOf: [
                { type: "string", description: "Comma-separated node IDs." },
                { type: "array", items: { type: "string" } },
              ],
            },
          },
          required: ["fileKey", "nodeIds"],
          additionalProperties: false,
        },
        run: async (ctx, args) => {
          const token = ensure(ctx.secrets.token || "", "Figma token is required");
          const fileKey = ensure(asString(args.fileKey), "fileKey is required");
          const nodeIds = asStringArray(args.nodeIds);
          if (nodeIds.length === 0) throw new Error("nodeIds is required");
          return await fetchJson({
            url: buildUrl("https://api.figma.com", `/v1/files/${encodeURIComponent(fileKey)}/nodes`, {
              ids: nodeIds.join(","),
            }),
            headers: {
              "X-Figma-Token": token,
            },
          });
        },
      },
    ],
  },
  {
    providerId: "mcp:notion",
    providerLabel: "Notion",
    implementationSource: "official",
    tools: [
      {
        command: "search",
        description: "Search Notion pages and databases.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            pageSize: { type: "number", default: 20 },
          },
          additionalProperties: false,
        },
        run: async (ctx, args) => {
          const query = asString(args.query);
          const pageSize = Math.max(1, Math.min(100, asNumber(args.pageSize, 20)));
          const payload = asObject(
            await notionApiCall(ctx, "/v1/search", "POST", {
              ...(query ? { query } : {}),
              page_size: pageSize,
            }),
          );
          const results = Array.isArray(payload.results) ? payload.results : [];
          return {
            count: results.length,
            results: results.map((item) => {
              const row = asObject(item);
              return {
                id: asString(row.id),
                object: asString(row.object),
                url: asString(row.url),
                lastEditedTime: asString(row.last_edited_time),
              };
            }),
          };
        },
      },
      {
        command: "get_page",
        description: "Get a Notion page by page ID.",
        inputSchema: {
          type: "object",
          properties: {
            pageId: { type: "string" },
          },
          required: ["pageId"],
          additionalProperties: false,
        },
        run: async (ctx, args) => {
          const pageId = ensure(asString(args.pageId), "pageId is required");
          return await notionApiCall(ctx, `/v1/pages/${encodeURIComponent(pageId)}`, "GET");
        },
      },
    ],
  },
  {
    providerId: "mcp:google-drive",
    providerLabel: "Google Drive",
    implementationSource: "official",
    tools: [
      {
        command: "files_list",
        description: "List Google Drive files.",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string" },
            pageSize: { type: "number", default: 20 },
          },
          additionalProperties: false,
        },
        run: async (ctx, args) => {
          const token = await resolveGoogleDriveAccessToken(ctx);
          const q = asString(args.q);
          const pageSize = Math.max(1, Math.min(1000, asNumber(args.pageSize, 20)));
          const payload = asObject(
            await fetchJson({
              url: buildUrl("https://www.googleapis.com", "/drive/v3/files", {
                pageSize,
                ...(q ? { q } : {}),
                fields:
                  "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress)),nextPageToken",
              }),
              headers: {
                Authorization: `Bearer ${token}`,
              },
            }),
          );
          const files = Array.isArray(payload.files) ? payload.files : [];
          return {
            count: files.length,
            files: files.map((item) => {
              const row = asObject(item);
              return {
                id: asString(row.id),
                name: asString(row.name),
                mimeType: asString(row.mimeType),
                modifiedTime: asString(row.modifiedTime),
                webViewLink: asString(row.webViewLink),
              };
            }),
            nextPageToken: asString(payload.nextPageToken),
          };
        },
      },
      {
        command: "file_get",
        description: "Get Google Drive file metadata by file ID.",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string" },
          },
          required: ["fileId"],
          additionalProperties: false,
        },
        run: async (ctx, args) => {
          const token = await resolveGoogleDriveAccessToken(ctx);
          const fileId = ensure(asString(args.fileId), "fileId is required");
          return await fetchJson({
            url: buildUrl("https://www.googleapis.com", `/drive/v3/files/${encodeURIComponent(fileId)}`, {
              fields: "id,name,mimeType,size,createdTime,modifiedTime,owners(displayName,emailAddress),webViewLink",
            }),
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });
        },
      },
    ],
  },
];

function resolveBuiltinProviderSpec(providerIdRaw: string) {
  const providerId = normalizeMcpProviderId(providerIdRaw);
  return MCP_RUNTIME_PROVIDERS.find((provider) => provider.providerId === providerId);
}

function toMarketToolDefinition(
  providerId: string,
  entry: McpProviderConfigEntry,
  tool: McpRuntimeToolRow,
): McpRuntimeToolDefinition | null {
  const command = asString(tool.command || tool.name);
  const name = asString(tool.name);
  if (!command || !name) return null;
  return {
    name: `${providerId}.${command}`,
    providerId,
    providerKind: "mcp",
    providerLabel: entry.label?.trim() || providerId,
    description: asString(tool.description) || `${entry.label || providerId} tool: ${command}`,
    inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: "object", additionalProperties: true },
    command,
    source: "market",
    implementationSource: "smithery",
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function listMcpRuntimeToolDefinitions(config: OpenClawConfig): McpRuntimeToolDefinition[] {
  const hub = readMcpHubConfig(config);
  const marketApiKey = resolveMarketApiKey(hub);
  const definitions: McpRuntimeToolDefinition[] = [];

  for (const [providerIdRaw, entry] of Object.entries(hub.builtinProviders)) {
    const providerId = normalizeMcpProviderId(providerIdRaw);
    if (!providerId || entry.enabled !== true) continue;
    const secrets = resolveProviderSecrets(entry);
    if (!hasRequiredSecrets(entry, secrets)) continue;
    const spec = resolveBuiltinProviderSpec(providerId);
    if (!spec) continue;
    const providerLabel = entry.label?.trim() || spec.providerLabel;
    for (const tool of spec.tools) {
      definitions.push({
        name: `${providerId}.${tool.command}`,
        providerId,
        providerKind: "mcp",
        providerLabel,
        description: tool.description,
        inputSchema: tool.inputSchema,
        command: tool.command,
        source: "builtin",
        implementationSource: spec.implementationSource,
      });
    }
  }

  for (const [providerIdRaw, entry] of Object.entries(hub.marketProviders)) {
    const providerId = normalizeMcpProviderId(providerIdRaw);
    if (!providerId || entry.enabled !== true) continue;
    const secrets = withMarketAuthFallback(entry, resolveProviderSecrets(entry), marketApiKey);
    if (!hasRequiredSecrets(entry, secrets)) continue;
    const tools = Array.isArray(entry.tools) ? entry.tools : [];
    for (const tool of tools) {
      const row = toMarketToolDefinition(providerId, entry, tool);
      if (row) definitions.push(row);
    }
  }

  return definitions;
}

function resolveMcpHttpEndpoint(entry: McpProviderConfigEntry): string {
  const connectionUrl = asString(entry.connection?.deploymentUrl);
  if (connectionUrl) return connectionUrl;
  const fromFields = asString(entry.fields?.deploymentUrl);
  if (fromFields) return fromFields;
  throw new Error("MCP provider missing deployment URL");
}

function buildMcpAuthHeaders(entry: McpProviderConfigEntry, secrets: Record<string, string>) {
  const headers: Record<string, string> = {
    // Streamable HTTP servers (including Smithery connect.mcp) may respond with SSE.
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  const authType = asString(entry.connection?.authType).toLowerCase() || "bearer";
  const token = normalizeBearerToken(secrets.token || secrets.apiKey || secrets.authToken);
  if (authType === "none") {
    // Some Smithery entries declare authType=none while deployment still accepts bearer.
    if (entry.source === "market" && token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }
  if (!token) {
    throw new Error("MCP provider auth token is required");
  }
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseSseJsonRpcResponse(text: string): McpJsonRpcResponse {
  // Minimal SSE parser for Streamable HTTP responses.
  // We only need the JSON payload emitted in `data:` lines.
  const blocks = String(text || "").split(/\r?\n\r?\n/);
  let last: McpJsonRpcResponse | null = null;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      dataLines.push(line.slice("data:".length).trimStart());
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        last = parsed as McpJsonRpcResponse;
      }
    } catch {
      // ignore invalid chunks
    }
  }
  if (!last) {
    throw new Error(`MCP endpoint returned SSE without JSON payload: ${String(text).slice(0, 240)}`);
  }
  return last;
}

async function postMcpJsonRpc(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs?: number;
  sessionId?: string;
}): Promise<{ payload: McpJsonRpcResponse; sessionId?: string }> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      ...params.headers,
      ...(params.sessionId ? { "mcp-session-id": params.sessionId } : {}),
    };
    const response = await fetch(params.url, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const text = await response.text();
    const contentType = asString(response.headers.get("content-type")).toLowerCase();
    let payload: McpJsonRpcResponse = {};
    if (text) {
      try {
        if (contentType.includes("text/event-stream")) {
          payload = parseSseJsonRpcResponse(text);
        } else {
          payload = JSON.parse(text) as McpJsonRpcResponse;
        }
      } catch (error) {
        throw new Error(
          `MCP endpoint returned non-JSON (${contentType || "unknown"}): ${text.slice(0, 500)}`,
        );
      }
    }
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return {
      payload,
      ...(response.headers.get("mcp-session-id") ? { sessionId: response.headers.get("mcp-session-id") || undefined } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function establishMcpHttpSession(params: {
  deploymentUrl: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ endpoint: string; sessionId?: string }> {
  const candidates = Array.from(
    new Set([
      params.deploymentUrl.replace(/\/+$/, ""),
      `${params.deploymentUrl.replace(/\/+$/, "")}/mcp`,
    ]),
  );
  const errors: string[] = [];
  for (const endpoint of candidates) {
    try {
      const init = await postMcpJsonRpc({
        url: endpoint,
        headers: params.headers,
        timeoutMs: params.timeoutMs,
        body: {
          jsonrpc: "2.0",
          id: "init-1",
          method: "initialize",
          params: {
            protocolVersion: INITIALIZE_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "openclaw", version: "0.0.0" },
          },
        },
      });
      if (init.payload?.error) {
        throw new Error(
          `initialize failed: ${String(init.payload.error.message || init.payload.error.code || "unknown")}`,
        );
      }
      await postMcpJsonRpc({
        url: endpoint,
        headers: params.headers,
        timeoutMs: params.timeoutMs,
        sessionId: init.sessionId,
        body: {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        },
      });
      return { endpoint, ...(init.sessionId ? { sessionId: init.sessionId } : {}) };
    } catch (error) {
      errors.push(`${endpoint}: ${String((error as Error)?.message || error || "unknown")}`);
    }
  }
  const preferredError =
    errors.find((item) => /(invalid[_\\s-]?token|authorization|unauthorized|\\b401\\b)/i.test(item)) ||
    errors.find((item) => !/server not found/i.test(item)) ||
    errors[0] ||
    "failed to initialize MCP session";
  throw new Error(preferredError);
}

async function mcpHttpToolsList(params: {
  deploymentUrl: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}): Promise<McpRuntimeToolRow[]> {
  const session = await establishMcpHttpSession(params);
  const listResult = await postMcpJsonRpc({
    url: session.endpoint,
    headers: params.headers,
    timeoutMs: params.timeoutMs,
    sessionId: session.sessionId,
    body: {
      jsonrpc: "2.0",
      id: "tools-list-1",
      method: "tools/list",
      params: {},
    },
  });
  if (listResult.payload?.error) {
    throw new Error(`tools/list failed: ${String(listResult.payload.error.message || "unknown")}`);
  }
  const result = asObject(listResult.payload.result);
  const tools = Array.isArray(result.tools) ? result.tools : [];
  const rows: McpRuntimeToolRow[] = [];
  for (const toolRaw of tools) {
    const tool = asObject(toolRaw);
    const name = asString(tool.name);
    if (!name) continue;
    rows.push({
      name,
      command: name,
      ...(asString(tool.description) ? { description: asString(tool.description) } : {}),
      ...(isPlainObject(tool.inputSchema) ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
    });
  }
  return rows;
}

function pickSmokeTool(tools: McpRuntimeToolRow[]): McpRuntimeToolRow | null {
  const safeVerb = /(list|get|search|read|fetch|status|health|info)/i;
  for (const tool of tools) {
    const schema = isPlainObject(tool.inputSchema) ? tool.inputSchema : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.length > 0) continue;
    if (safeVerb.test(tool.name) || safeVerb.test(asString(tool.description))) {
      return tool;
    }
  }
  for (const tool of tools) {
    const schema = isPlainObject(tool.inputSchema) ? tool.inputSchema : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.length === 0) return tool;
  }
  return null;
}

async function mcpHttpToolCall(params: {
  deploymentUrl: string;
  headers: Record<string, string>;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<unknown> {
  const session = await establishMcpHttpSession({
    deploymentUrl: params.deploymentUrl,
    headers: params.headers,
    timeoutMs: params.timeoutMs,
  });
  const callResult = await postMcpJsonRpc({
    url: session.endpoint,
    headers: params.headers,
    timeoutMs: params.timeoutMs,
    sessionId: session.sessionId,
    body: {
      jsonrpc: "2.0",
      id: "tools-call-1",
      method: "tools/call",
      params: {
        name: params.toolName,
        arguments: params.args,
      },
    },
  });
  if (callResult.payload?.error) {
    throw new Error(`tools/call failed: ${String(callResult.payload.error.message || "unknown")}`);
  }
  return callResult.payload.result ?? {};
}

export async function preflightMcpHttpProvider(params: {
  provider: McpProviderConfigEntry;
  secrets: Record<string, string>;
  timeoutMs?: number;
}): Promise<McpHttpPreflightResult> {
  try {
    const deploymentUrl = resolveMcpHttpEndpoint(params.provider);
    const headers = buildMcpAuthHeaders(params.provider, params.secrets);
    const tools = await mcpHttpToolsList({
      deploymentUrl,
      headers,
      timeoutMs: params.timeoutMs,
    });
    if (tools.length === 0) {
      return {
        ok: false,
        toolCount: 0,
        listedTools: [],
        error: "No tools exposed by MCP provider",
        deploymentUrl,
      };
    }
    const smoke = pickSmokeTool(tools);
    if (smoke) {
      await mcpHttpToolCall({
        deploymentUrl,
        headers,
        toolName: smoke.command || smoke.name,
        args: {},
        timeoutMs: params.timeoutMs,
      });
    }
    return {
      ok: true,
      toolCount: tools.length,
      listedTools: tools.map((tool) => tool.name),
      ...(smoke ? { smokeTool: smoke.name } : {}),
      deploymentUrl,
    };
  } catch (error) {
    return {
      ok: false,
      toolCount: 0,
      listedTools: [],
      error: String((error as Error)?.message || error || "unknown"),
    };
  }
}

export async function discoverMcpHttpTools(params: {
  provider: McpProviderConfigEntry;
  secrets: Record<string, string>;
  timeoutMs?: number;
}): Promise<McpRuntimeToolRow[]> {
  const deploymentUrl = resolveMcpHttpEndpoint(params.provider);
  const headers = buildMcpAuthHeaders(params.provider, params.secrets);
  return await mcpHttpToolsList({
    deploymentUrl,
    headers,
    timeoutMs: params.timeoutMs,
  });
}

async function invokeMarketRuntimeTool(params: {
  providerId: string;
  entry: McpProviderConfigEntry;
  args: Record<string, unknown>;
  command: string;
  secrets: Record<string, string>;
  timeoutMs?: number;
}) {
  const deploymentUrl = resolveMcpHttpEndpoint(params.entry);
  const headers = buildMcpAuthHeaders(params.entry, params.secrets);
  return await mcpHttpToolCall({
    deploymentUrl,
    headers,
    toolName: params.command,
    args: params.args,
    timeoutMs: params.timeoutMs,
  });
}

export async function invokeMcpRuntimeTool(params: McpRuntimeInvokeParams) {
  const providerId = normalizeMcpProviderId(params.providerId);
  const hub = readMcpHubConfig(params.config);
  const marketApiKey = resolveMarketApiKey(hub);
  const builtinSpec = resolveBuiltinProviderSpec(providerId);
  const ctx = resolveProviderState(params.config, providerId);
  const args = asObject(params.args);
  const command = asString(params.command);

  if (builtinSpec) {
    const tool = builtinSpec.tools.find((candidate) => candidate.command === command);
    if (!tool) {
      throw new Error(`Unknown MCP tool command: ${providerId}.${command}`);
    }
    return await tool.run(ctx, args);
  }

  const marketEntry = hub.marketProviders[providerId];
  if (!marketEntry) {
    throw new Error(`Unsupported MCP provider: ${providerId}`);
  }
  const marketSecrets = withMarketAuthFallback(marketEntry, ctx.secrets, marketApiKey);
  return await invokeMarketRuntimeTool({
    providerId,
    entry: marketEntry,
    args,
    command,
    secrets: marketSecrets,
    timeoutMs: params.timeoutMs,
  });
}

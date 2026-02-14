import type { OpenClawConfig } from "../config/config.js";
import type { McpHubConfig, McpProviderConfigEntry, McpRuntimeToolRow } from "./config.js";
import { listAllMcpProviders, normalizeMcpProviderId, readMcpHubConfig } from "./config.js";
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
  fields: Record<string, unknown>;
  secrets: Record<string, string>;
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

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asNumber(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function ensure(value: string, message: string): string {
  const next = String(value || "").trim();
  if (!next) {
    throw new Error(message);
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBearerToken(value: unknown): string {
  const raw = asString(value);
  if (!raw) return "";
  const match = raw.match(/^bearer\s+(.+)$/i);
  return match ? asString(match[1]) : raw;
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
    fields: (entry.fields as Record<string, unknown> | undefined) || {},
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
    return false;
  }
  return true;
}

function resolveMcpHttpEndpoint(entry: McpProviderConfigEntry): string {
  const connectionUrl = asString(entry.connection?.deploymentUrl);
  if (connectionUrl) return connectionUrl;
  const fromFields = asString((entry.fields as any)?.deploymentUrl);
  if (fromFields) return fromFields;
  throw new Error("MCP provider missing deployment URL");
}

function buildMcpAuthHeaders(entry: McpProviderConfigEntry, secrets: Record<string, string>) {
  const headers: Record<string, string> = {
    // Streamable HTTP servers may respond with SSE.
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  const authType = asString(entry.connection?.authType).toLowerCase() || "bearer";
  if (authType === "none") {
    return headers;
  }
  const token = normalizeBearerToken(secrets.token || secrets.apiKey || secrets.authToken);
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
  sessionId?: string;
  timeoutMs?: number;
}): Promise<{ payload: McpJsonRpcResponse }> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(params.url, {
      method: "POST",
      headers: {
        ...params.headers,
        ...(params.sessionId ? { "Mcp-Session-Id": params.sessionId } : {}),
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const text = await response.text();
    const contentType = asString(response.headers.get("content-type")).toLowerCase();
    let payload: McpJsonRpcResponse = {};
    if (text) {
      try {
        payload = contentType.includes("text/event-stream") ? parseSseJsonRpcResponse(text) : (JSON.parse(text) as McpJsonRpcResponse);
      } catch {
        throw new Error(
          `MCP endpoint returned non-JSON (${contentType || "unknown"}): ${text.slice(0, 500)}`,
        );
      }
    }
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return { payload };
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
            clientInfo: {
              name: "openclaw-gateway",
              version: "dev",
            },
          },
        },
      });
      if (init.payload?.error) {
        throw new Error(`initialize failed: ${String(init.payload.error.message || "unknown")}`);
      }
      const result = asObject(init.payload.result);
      const sessionId = asString(result.sessionId);
      await postMcpJsonRpc({
        url: endpoint,
        headers: params.headers,
        timeoutMs: params.timeoutMs,
        sessionId: sessionId || undefined,
        body: {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        },
      });
      return { endpoint, ...(sessionId ? { sessionId } : {}) };
    } catch (error) {
      errors.push(`${endpoint}: ${String((error as Error)?.message || error || "unknown")}`);
    }
  }
  const preferredError =
    errors.find((item) => /(invalid[_\\s-]?token|authorization|unauthorized|\\b401\\b)/i.test(item)) ||
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

function pickSmokeTool(tools: McpRuntimeToolRow[]): McpRuntimeToolRow | null {
  const safeVerb = /(list|get|search|read|fetch|status|health|info)/i;
  for (const tool of tools) {
    const schema = isPlainObject(tool.inputSchema) ? tool.inputSchema : {};
    const required = Array.isArray((schema as any).required) ? ((schema as any).required as unknown[]) : [];
    if (required.length > 0) continue;
    if (safeVerb.test(tool.name) || safeVerb.test(asString(tool.description))) {
      return tool;
    }
  }
  for (const tool of tools) {
    const schema = isPlainObject(tool.inputSchema) ? tool.inputSchema : {};
    const required = Array.isArray((schema as any).required) ? ((schema as any).required as unknown[]) : [];
    if (required.length === 0) return tool;
  }
  return null;
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

function toToolDefinitions(providerId: string, entry: McpProviderConfigEntry, tools: McpRuntimeToolRow[]) {
  const out: McpRuntimeToolDefinition[] = [];
  for (const tool of tools) {
    const command = asString(tool.command || tool.name);
    const name = asString(tool.name);
    if (!command || !name) continue;
    out.push({
      name: `${providerId}.${command}`,
      providerId,
      providerKind: "mcp",
      providerLabel: entry.label?.trim() || providerId,
      description: asString(tool.description) || `${entry.label || providerId} tool: ${command}`,
      inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: "object", additionalProperties: true },
      command,
    });
  }
  return out;
}

export function listMcpRuntimeToolDefinitions(config: OpenClawConfig): McpRuntimeToolDefinition[] {
  const hub: McpHubConfig = readMcpHubConfig(config);
  const providers = listAllMcpProviders(hub);
  const definitions: McpRuntimeToolDefinition[] = [];

  for (const [providerIdRaw, entry] of Object.entries(providers)) {
    const providerId = normalizeMcpProviderId(providerIdRaw);
    if (!providerId || entry.enabled !== true) continue;
    const secrets = resolveProviderSecrets(entry);
    if (!hasRequiredSecrets(entry, secrets)) continue;
    const tools = Array.isArray(entry.tools) ? entry.tools : [];
    if (tools.length === 0) continue;
    definitions.push(...toToolDefinitions(providerId, entry, tools));
  }

  return definitions;
}

export async function invokeMcpRuntimeTool(params: McpRuntimeInvokeParams) {
  const ctx = resolveProviderState(params.config, params.providerId);
  const command = ensure(asString(params.command), "command is required");
  const args = asObject(params.args);
  const deploymentUrl = resolveMcpHttpEndpoint(ctx.entry);
  const headers = buildMcpAuthHeaders(ctx.entry, ctx.secrets);
  return await mcpHttpToolCall({
    deploymentUrl,
    headers,
    toolName: command,
    args,
    timeoutMs: params.timeoutMs,
  });
}


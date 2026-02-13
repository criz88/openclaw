import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig, resolveConfigSnapshotHash } from "../../config/io.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;

function resolveBaseHashFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const hashValue = (snapshot as { hash?: unknown }).hash;
  const rawValue = (snapshot as { raw?: unknown }).raw;
  const hash = resolveConfigSnapshotHash({
    hash: typeof hashValue === "string" ? hashValue : undefined,
    raw: typeof rawValue === "string" ? rawValue : undefined,
  });
  return hash ?? undefined;
}

const GATEWAY_ACTIONS = [
  "restart",
  "config.get",
  "config.schema",
  "config.apply",
  "config.patch",
  "update.run",
  "mcp.presets.list",
  "mcp.providers.snapshot",
  "mcp.providers.apply",
  "mcp.market.search",
  "mcp.market.detail",
  "mcp.market.install",
  "mcp.market.uninstall",
  "mcp.market.refresh",
  "tools.list",
  "tools.call",
] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  // restart
  delayMs: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  // config.get, config.schema, config.apply, update.run
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  // config.apply, config.patch
  raw: Type.Optional(Type.String()),
  baseHash: Type.Optional(Type.String()),
  // mcp.providers.apply
  providers: Type.Optional(Type.Array(Type.Unknown())),
  mcpProviders: Type.Optional(Type.Array(Type.Unknown())),
  // mcp.market.search
  query: Type.Optional(Type.String()),
  page: Type.Optional(Type.Number()),
  pageSize: Type.Optional(Type.Number()),
  registryBaseUrl: Type.Optional(Type.String()),
  // mcp.market.detail, mcp.market.install
  qualifiedName: Type.Optional(Type.String()),
  // mcp.market.install
  providerLabel: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  mcpFields: Type.Optional(Type.Unknown()),
  mcpSecretValues: Type.Optional(Type.Unknown()),
  smitheryApiKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // config.apply, config.patch, update.run
  sessionKey: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  restartDelayMs: Type.Optional(Type.Number()),
  // tools.list
  providerKind: Type.Optional(Type.String()),
  providerId: Type.Optional(Type.String()),
  providerIds: Type.Optional(Type.Array(Type.String())),
  includeBuiltin: Type.Optional(Type.Boolean()),
  // tools.call
  toolName: Type.Optional(Type.String()),
  toolArgs: Type.Optional(Type.Unknown()),
});
// NOTE: We intentionally avoid top-level `allOf`/`anyOf`/`oneOf` conditionals here:
// - OpenAI rejects tool schemas that include these keywords at the *top-level*.
// - Claude/Vertex has other JSON Schema quirks.
// Conditional requirements (like `raw` for config.apply) are enforced at runtime.

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    description:
      "Restart, apply config, or update the gateway in-place (SIGUSR1). Use config.patch for safe partial config updates (merges with existing). Use config.apply only when replacing entire config. Both trigger restart after writing.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "restart") {
        if (opts?.config?.commands?.restart !== true) {
          throw new Error("Gateway restart is disabled. Set commands.restart=true to enable.");
        }
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const delayMs =
          typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
            ? Math.floor(params.delayMs)
            : undefined;
        const reason =
          typeof params.reason === "string" && params.reason.trim()
            ? params.reason.trim().slice(0, 200)
            : undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        // Extract channel + threadId for routing after restart
        let deliveryContext: { channel?: string; to?: string; accountId?: string } | undefined;
        let threadId: string | undefined;
        if (sessionKey) {
          const threadMarker = ":thread:";
          const threadIndex = sessionKey.lastIndexOf(threadMarker);
          const baseSessionKey = threadIndex === -1 ? sessionKey : sessionKey.slice(0, threadIndex);
          const threadIdRaw =
            threadIndex === -1 ? undefined : sessionKey.slice(threadIndex + threadMarker.length);
          threadId = threadIdRaw?.trim() || undefined;
          try {
            const cfg = loadConfig();
            const storePath = resolveStorePath(cfg.session?.store);
            const store = loadSessionStore(storePath);
            let entry = store[sessionKey];
            if (!entry?.deliveryContext && threadIndex !== -1 && baseSessionKey) {
              entry = store[baseSessionKey];
            }
            if (entry?.deliveryContext) {
              deliveryContext = {
                channel: entry.deliveryContext.channel,
                to: entry.deliveryContext.to,
                accountId: entry.deliveryContext.accountId,
              };
            }
          } catch {
            // ignore: best-effort
          }
        }
        const payload: RestartSentinelPayload = {
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
          },
        };
        try {
          await writeRestartSentinel(payload);
        } catch {
          // ignore: sentinel is best-effort
        }
        console.info(
          `gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`,
        );
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
        });
        return jsonResult(scheduled);
      }

      const gatewayUrl =
        typeof params.gatewayUrl === "string" && params.gatewayUrl.trim()
          ? params.gatewayUrl.trim()
          : undefined;
      const gatewayToken =
        typeof params.gatewayToken === "string" && params.gatewayToken.trim()
          ? params.gatewayToken.trim()
          : undefined;
      const timeoutMs =
        typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
          ? Math.max(1, Math.floor(params.timeoutMs))
          : undefined;
      const gatewayOpts = { gatewayUrl, gatewayToken, timeoutMs };

      if (action === "config.get") {
        const result = await callGatewayTool("config.get", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema") {
        const result = await callGatewayTool("config.schema", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.apply") {
        const raw = readStringParam(params, "raw", { required: true });
        let baseHash = readStringParam(params, "baseHash");
        if (!baseHash) {
          const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        const result = await callGatewayTool("config.apply", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.patch") {
        const raw = readStringParam(params, "raw", { required: true });
        let baseHash = readStringParam(params, "baseHash");
        if (!baseHash) {
          const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        const result = await callGatewayTool("config.patch", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "update.run") {
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        const updateGatewayOpts = {
          ...gatewayOpts,
          timeoutMs: timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS,
        };
        const result = await callGatewayTool("update.run", updateGatewayOpts, {
          sessionKey,
          note,
          restartDelayMs,
          timeoutMs: timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "mcp.presets.list") {
        const result = await callGatewayTool("mcp.presets.list", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "mcp.providers.snapshot") {
        const result = await callGatewayTool("mcp.providers.snapshot", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "mcp.providers.apply") {
        const providers = Array.isArray(params.providers)
          ? params.providers
          : Array.isArray(params.mcpProviders)
            ? params.mcpProviders
            : [];
        const baseHash = readStringParam(params, "baseHash");
        const result = await callGatewayTool("mcp.providers.apply", gatewayOpts, {
          providers,
          ...(baseHash ? { baseHash } : {}),
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "mcp.market.search") {
        const query = readStringParam(params, "query");
        const page =
          typeof params.page === "number" && Number.isFinite(params.page)
            ? Math.max(1, Math.floor(params.page))
            : undefined;
        const pageSize =
          typeof params.pageSize === "number" && Number.isFinite(params.pageSize)
            ? Math.max(1, Math.floor(params.pageSize))
            : undefined;
        const registryBaseUrl = readStringParam(params, "registryBaseUrl");
        const result = await callGatewayTool("mcp.market.search", gatewayOpts, {
          ...(query ? { query } : {}),
          ...(page ? { page } : {}),
          ...(pageSize ? { pageSize } : {}),
          ...(registryBaseUrl ? { registryBaseUrl } : {}),
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "mcp.market.detail") {
        const qualifiedName = readStringParam(params, "qualifiedName", { required: true });
        const registryBaseUrl = readStringParam(params, "registryBaseUrl");
        const result = await callGatewayTool("mcp.market.detail", gatewayOpts, {
          qualifiedName,
          ...(registryBaseUrl ? { registryBaseUrl } : {}),
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "mcp.market.install") {
        const qualifiedName = readStringParam(params, "qualifiedName", { required: true });
        const providerId = readStringParam(params, "providerId");
        const providerLabel = readStringParam(params, "providerLabel");
        const baseHash = readStringParam(params, "baseHash");
        const enabled =
          typeof params.enabled === "boolean" ? params.enabled : undefined;
        const registryBaseUrl = readStringParam(params, "registryBaseUrl");
        const mcpFields =
          params.mcpFields && typeof params.mcpFields === "object" && !Array.isArray(params.mcpFields)
            ? params.mcpFields
            : undefined;
        const mcpSecretValues =
          params.mcpSecretValues &&
          typeof params.mcpSecretValues === "object" &&
          !Array.isArray(params.mcpSecretValues)
            ? params.mcpSecretValues
            : undefined;
        const smitheryApiKey =
          typeof params.smitheryApiKey === "string" || params.smitheryApiKey === null
            ? params.smitheryApiKey
            : undefined;
        const result = await callGatewayTool("mcp.market.install", gatewayOpts, {
          qualifiedName,
          ...(providerId ? { providerId } : {}),
          ...(providerLabel ? { label: providerLabel } : {}),
          ...(baseHash ? { baseHash } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(mcpFields ? { fields: mcpFields } : {}),
          ...(mcpSecretValues ? { secretValues: mcpSecretValues } : {}),
          ...(registryBaseUrl ? { registryBaseUrl } : {}),
          ...(smitheryApiKey !== undefined ? { smitheryApiKey } : {}),
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "mcp.market.uninstall") {
        const providerId = readStringParam(params, "providerId", { required: true });
        const baseHash = readStringParam(params, "baseHash");
        const result = await callGatewayTool("mcp.market.uninstall", gatewayOpts, {
          providerId,
          ...(baseHash ? { baseHash } : {}),
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "mcp.market.refresh") {
        const baseHash = readStringParam(params, "baseHash");
        const registryBaseUrl = readStringParam(params, "registryBaseUrl");
        const smitheryApiKey =
          typeof params.smitheryApiKey === "string" || params.smitheryApiKey === null
            ? params.smitheryApiKey
            : undefined;
        const result = await callGatewayTool("mcp.market.refresh", gatewayOpts, {
          ...(baseHash ? { baseHash } : {}),
          ...(registryBaseUrl ? { registryBaseUrl } : {}),
          ...(smitheryApiKey !== undefined ? { smitheryApiKey } : {}),
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "tools.list") {
        const providerKindRaw = readStringParam(params, "providerKind");
        const providerKind =
          providerKindRaw && ["mcp", "companion", "builtin"].includes(providerKindRaw.trim())
            ? providerKindRaw.trim()
            : undefined;
        const providerId = readStringParam(params, "providerId");
        const providerIds =
          Array.isArray(params.providerIds) && params.providerIds.length > 0
            ? params.providerIds
                .filter((value) => typeof value === "string")
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined;
        const includeBuiltin =
          typeof params.includeBuiltin === "boolean" ? params.includeBuiltin : undefined;
        const listResult = await callGatewayTool<{
          ok?: boolean;
          definitions?: Array<Record<string, unknown>>;
        }>("tools.list", gatewayOpts, {
          ...(providerId ? { providerId } : {}),
          ...(providerIds && providerIds.length > 0 ? { providerIds } : {}),
          ...(providerKind ? { providerKind } : {}),
          ...(includeBuiltin !== undefined ? { includeBuiltin } : {}),
        });
        const definitions = Array.isArray(listResult?.definitions) ? listResult.definitions : [];
        const filtered =
          providerKind === undefined
            ? definitions
            : definitions.filter((definition) => {
                const rawKind = String(definition?.providerKind || "").trim();
                return rawKind === providerKind;
              });
        return jsonResult({
          ok: true,
          count: filtered.length,
          definitions: filtered,
        });
      }
      if (action === "tools.call") {
        const providerId = readStringParam(params, "providerId", { required: true });
        const toolName = readStringParam(params, "toolName", { required: true });
        const toolArgs =
          params.toolArgs && typeof params.toolArgs === "object" && !Array.isArray(params.toolArgs)
            ? params.toolArgs
            : {};
        const invokeResult = await callGatewayTool("tools.call", gatewayOpts, {
          providerId,
          toolName,
          params: toolArgs,
          ...(timeoutMs ? { timeoutMs } : {}),
        });

        return jsonResult({
          ok: true,
          providerId,
          toolName,
          result: invokeResult,
        });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}

import { randomUUID } from "node:crypto";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { agentCommand } from "../commands/agent.js";
import { loadConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

const slugifySessionSuffix = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const sanitizeNodeSessionKey = (
  sessionKey: string,
  nodeId: string,
  nodeDisplayName?: string,
): string => {
  const trimmed = sessionKey.trim();
  if (!trimmed) return trimmed;
  const lastColon = trimmed.lastIndexOf(":");
  const keyPrefix = lastColon >= 0 ? trimmed.slice(0, lastColon + 1) : "";
  const keyTail = lastColon >= 0 ? trimmed.slice(lastColon + 1) : trimmed;
  const keyPrefixes = ["desktop-node-", "desktop-", "node-"];
  const matchedPrefix = keyPrefixes.find((prefix) => keyTail.startsWith(prefix));
  if (!matchedPrefix) {
    return trimmed;
  }
  const suffix = keyTail.slice(matchedPrefix.length).trim();
  const nameSlug = nodeDisplayName ? slugifySessionSuffix(nodeDisplayName) : "";
  const shortNodeId = slugifySessionSuffix(nodeId).slice(0, 12);
  const replacement = nameSlug || shortNodeId || "node";
  if (!suffix || suffix === nodeId || suffix.length > 24) {
    return `${keyPrefix}${matchedPrefix}${replacement}`;
  }
  return trimmed;
};

const mergeSessionEntries = (
  target: Record<string, unknown> | undefined,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  if (!target) return source;
  const targetUpdatedAt =
    typeof target.updatedAt === "number" && Number.isFinite(target.updatedAt) ? target.updatedAt : 0;
  const sourceUpdatedAt =
    typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt) ? source.updatedAt : 0;
  return {
    ...source,
    ...target,
    updatedAt: Math.max(targetUpdatedAt, sourceUpdatedAt) || undefined,
  };
};

const migrateLegacyNodeSessionKeys = (params: {
  store: Record<string, Record<string, unknown>>;
  canonicalKey: string;
  nodeId: string;
  nodeDisplayName?: string;
}) => {
  const canonical = params.canonicalKey.trim();
  if (!canonical) return canonical;
  const lastColon = canonical.lastIndexOf(":");
  const keyPrefix = lastColon >= 0 ? canonical.slice(0, lastColon + 1) : "";
  const normalizedNodeId = params.nodeId.trim();
  if (!normalizedNodeId) return canonical;
  const legacyKeys = [
    `${keyPrefix}desktop-${normalizedNodeId}`,
    `${keyPrefix}desktop-node-${normalizedNodeId}`,
    `${keyPrefix}node-${normalizedNodeId}`,
  ];
  let targetKey = sanitizeNodeSessionKey(canonical, params.nodeId, params.nodeDisplayName);
  if (targetKey !== canonical && params.store[canonical]) {
    params.store[targetKey] = mergeSessionEntries(params.store[targetKey], params.store[canonical]);
    delete params.store[canonical];
  }
  for (const key of legacyKeys) {
    if (key === targetKey) continue;
    const entry = params.store[key];
    if (!entry) continue;
    params.store[targetKey] = mergeSessionEntries(params.store[targetKey], entry);
    delete params.store[key];
  }
  return targetKey;
};

export const handleNodeEvent = async (ctx: NodeEventContext, nodeId: string, evt: NodeEvent) => {
  const nodeDisplayName = ctx.nodeRegistry.get(nodeId)?.displayName;
  switch (evt.event) {
    case "voice.transcript": {
      if (!evt.payloadJSON) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(evt.payloadJSON) as unknown;
      } catch {
        return;
      }
      const obj =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      if (!text) {
        return;
      }
      if (text.length > 20_000) {
        return;
      }
      const sessionKeyRaw = typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
      const cfg = loadConfig();
      const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;
      const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          const targetKey = migrateLegacyNodeSessionKeys({
            store: store as Record<string, Record<string, unknown>>,
            canonicalKey,
            nodeId,
            nodeDisplayName,
          });
          const existing = store[targetKey] ?? entry;
          store[targetKey] = {
            sessionId,
            updatedAt: now,
            thinkingLevel: existing?.thinkingLevel,
            verboseLevel: existing?.verboseLevel,
            reasoningLevel: existing?.reasoningLevel,
            systemSent: existing?.systemSent,
            sendPolicy: existing?.sendPolicy,
            lastChannel: existing?.lastChannel,
            lastTo: existing?.lastTo,
          };
        });
      }

      // Ensure chat UI clients refresh when this run completes (even though it wasn't started via chat.send).
      // This maps agent bus events (keyed by sessionId) to chat events (keyed by clientRunId).
      ctx.addChatRun(sessionId, {
        sessionKey,
        clientRunId: `voice-${randomUUID()}`,
      });

      void agentCommand(
        {
          message: text,
          sessionId,
          sessionKey,
          thinking: "low",
          deliver: false,
          messageChannel: "node",
        },
        defaultRuntime,
        ctx.deps,
      ).catch((err) => {
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
      });
      return;
    }
    case "agent.request": {
      if (!evt.payloadJSON) {
        return;
      }
      type AgentDeepLink = {
        message?: string;
        sessionKey?: string | null;
        thinking?: string | null;
        deliver?: boolean;
        to?: string | null;
        channel?: string | null;
        timeoutSeconds?: number | null;
        key?: string | null;
      };
      let link: AgentDeepLink | null = null;
      try {
        link = JSON.parse(evt.payloadJSON) as AgentDeepLink;
      } catch {
        return;
      }
      const message = (link?.message ?? "").trim();
      if (!message) {
        return;
      }
      if (message.length > 20_000) {
        return;
      }

      const channelRaw = typeof link?.channel === "string" ? link.channel.trim() : "";
      const channel = normalizeChannelId(channelRaw) ?? undefined;
      const to = typeof link?.to === "string" && link.to.trim() ? link.to.trim() : undefined;
      const deliver = Boolean(link?.deliver) && Boolean(channel);

      const sessionKeyRaw = (link?.sessionKey ?? "").trim();
      const sessionKey =
        sessionKeyRaw.length > 0
          ? sanitizeNodeSessionKey(sessionKeyRaw, nodeId, nodeDisplayName)
          : `desktop-${slugifySessionSuffix(nodeDisplayName ?? "") || slugifySessionSuffix(nodeId).slice(0, 12) || "node"}`;
      const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          const targetKey = migrateLegacyNodeSessionKeys({
            store: store as Record<string, Record<string, unknown>>,
            canonicalKey,
            nodeId,
            nodeDisplayName,
          });
          const existing = store[targetKey] ?? entry;
          store[targetKey] = {
            sessionId,
            updatedAt: now,
            thinkingLevel: existing?.thinkingLevel,
            verboseLevel: existing?.verboseLevel,
            reasoningLevel: existing?.reasoningLevel,
            systemSent: existing?.systemSent,
            sendPolicy: existing?.sendPolicy,
            lastChannel: existing?.lastChannel,
            lastTo: existing?.lastTo,
          };
        });
      }

      void agentCommand(
        {
          message,
          sessionId,
          sessionKey,
          thinking: link?.thinking ?? undefined,
          deliver,
          to,
          channel,
          timeout:
            typeof link?.timeoutSeconds === "number" ? link.timeoutSeconds.toString() : undefined,
          messageChannel: "node",
        },
        defaultRuntime,
        ctx.deps,
      ).catch((err) => {
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
      });
      return;
    }
    case "chat.subscribe": {
      if (!evt.payloadJSON) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(evt.payloadJSON) as unknown;
      } catch {
        return;
      }
      const obj =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const sessionKey = typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
      if (!sessionKey) {
        return;
      }
      ctx.nodeSubscribe(nodeId, sessionKey);
      return;
    }
    case "actions.register": {
      if (!evt.payloadJSON) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(evt.payloadJSON) as unknown;
      } catch {
        return;
      }
      const obj =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const actionsRaw = Array.isArray(obj.actions) ? obj.actions : [];
      const actions = actionsRaw
        .map((entry) => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null))
        .filter(Boolean)
        .map((entry) => ({
          id: String((entry as Record<string, unknown>)?.id ?? "").trim(),
          label: typeof (entry as Record<string, unknown>)?.label === "string" ? String((entry as Record<string, unknown>)?.label) : undefined,
          description:
            typeof (entry as Record<string, unknown>)?.description === "string"
              ? String((entry as Record<string, unknown>)?.description)
              : undefined,
          command: String((entry as Record<string, unknown>)?.command ?? "").trim(),
          params: (entry as Record<string, unknown>)?.params as unknown,
        }))
        .filter((entry) => entry.id && entry.command);
      if (actions.length === 0) {
        return;
      }
      ctx.nodeRegistry.setActions(nodeId, actions);
      ctx.broadcast("node.actions.updated", { nodeId, actions }, { dropIfSlow: true });
      return;
    }
    case "chat.unsubscribe": {
      if (!evt.payloadJSON) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(evt.payloadJSON) as unknown;
      } catch {
        return;
      }
      const obj =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const sessionKey = typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
      if (!sessionKey) {
        return;
      }
      ctx.nodeUnsubscribe(nodeId, sessionKey);
      return;
    }
    case "exec.started":
    case "exec.finished":
    case "exec.denied": {
      if (!evt.payloadJSON) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(evt.payloadJSON) as unknown;
      } catch {
        return;
      }
      const obj =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const sessionKey =
        typeof obj.sessionKey === "string"
          ? sanitizeNodeSessionKey(obj.sessionKey, nodeId, nodeDisplayName)
          : `desktop-${slugifySessionSuffix(nodeDisplayName ?? "") || slugifySessionSuffix(nodeId).slice(0, 12) || "node"}`;
      if (!sessionKey) {
        return;
      }
      const { storePath, canonicalKey } = loadSessionEntry(sessionKey);
      if (storePath) {
        try {
          await updateSessionStore(storePath, (store) => {
            migrateLegacyNodeSessionKeys({
              store: store as Record<string, Record<string, unknown>>,
              canonicalKey,
              nodeId,
              nodeDisplayName,
            });
          });
        } catch {
          // Best-effort migration; ignore write failures for exec event path.
        }
      }
      const runId = typeof obj.runId === "string" ? obj.runId.trim() : "";
      const command = typeof obj.command === "string" ? obj.command.trim() : "";
      const exitCode =
        typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode)
          ? obj.exitCode
          : undefined;
      const timedOut = obj.timedOut === true;
      const output = typeof obj.output === "string" ? obj.output.trim() : "";
      const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";

      let text = "";
      if (evt.event === "exec.started") {
        text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      } else if (evt.event === "exec.finished") {
        const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
        text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
        if (output) {
          text += `\n${output}`;
        }
      } else {
        text = `Exec denied (node=${nodeId}${runId ? ` id=${runId}` : ""}${reason ? `, ${reason}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      }

      enqueueSystemEvent(text, { sessionKey, contextKey: runId ? `exec:${runId}` : "exec" });
      requestHeartbeatNow({ reason: "exec-event" });
      return;
    }
    default:
      return;
  }
};

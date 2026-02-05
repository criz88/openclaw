import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { agentCommand } from "../commands/agent.js";
import { defaultRuntime } from "../runtime.js";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/config.js";
import type { NodeRegistry } from "./node-registry.js";
import { CONFIG_PATH, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { VERSION } from "../version.js";
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  resolveGatewayReloadSettings,
} from "./config-reload.js";

export type AdminPipeReloadHandlers = {
  applyHotReload: (
    plan: ReturnType<typeof buildGatewayReloadPlan>,
    next: OpenClawConfig,
  ) => Promise<void>;
  requestGatewayRestart: (
    plan: ReturnType<typeof buildGatewayReloadPlan>,
    next: OpenClawConfig,
  ) => void;
};

export type AdminPipeServer = {
  path: string;
  close: () => Promise<void>;
};

const extractJsonFromLog = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const start = Math.min(
    ...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((idx) => idx >= 0),
  );
  if (!Number.isFinite(start)) return null;
  const payload = trimmed.slice(start);
  return JSON.parse(payload);
};

async function runJsonCommand(run: (runtime: typeof defaultRuntime) => Promise<void>) {
  let output = "";
  let lastError = "";
  await run({
    ...defaultRuntime,
    log: (...args) => {
      output += `${args.map((entry) => String(entry)).join(" ")}\n`;
      defaultRuntime.log(...args);
    },
    error: (...args) => {
      lastError = args.map((entry) => String(entry)).join(" ");
      defaultRuntime.error(...args);
    },
    exit: () => {
      throw new Error("runtime.exit");
    },
  });
  const parsed = extractJsonFromLog(output);
  if (parsed == null) {
    throw new Error(lastError || "No JSON output");
  }
  return parsed;
}

function resolveAdminPipePath() {
  const env = String(process.env.OPENCLAW_ADMIN_PIPE || "").trim();
  if (env) return env;
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\openclaw-admin";
  }
  return path.join(os.tmpdir(), "openclaw-admin.sock");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function runCowsay(): Promise<{ ok: boolean; output?: string; error?: string }> {
  return await new Promise((resolve) => {
    const proc = spawn("uv", ["tool", "run", "cowsay", "-t", "Phase 2 OK"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (chunk) => (out += String(chunk)));
    proc.stderr?.on("data", (chunk) => (err += String(chunk)));
    proc.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, output: out.trim() });
      else resolve({ ok: false, error: err.trim() || "cowsay failed" });
    });
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function extractAssistantTexts(result: any): string[] {
  const payloads = Array.isArray(result?.payloads) ? result.payloads : [];
  const texts = payloads
    .map((p: any) => (typeof p?.text === "string" ? p.text.trim() : ""))
    .filter((t: string) => t.length > 0);
  return texts;
}

function buildToolsPrompt(nodeRegistry: NodeRegistry): string {
  const tools = nodeRegistry
    .listConnected()
    .flatMap((node) =>
      (node.actions ?? []).map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description,
        command: action.command,
        params: action.params,
        nodeId: node.nodeId,
        nodeName: node.displayName || node.nodeId,
      })),
    );
  if (tools.length === 0) return "";
  const lines: string[] = ["Available actions (tools.list):"];
  for (const tool of tools) {
    const label = tool.label || tool.id;
    const desc = tool.description ? ` — ${tool.description}` : "";
    const node = tool.nodeName ? ` @ ${tool.nodeName}` : "";
    lines.push(`- ${label}${node} (command: ${tool.command})${desc}`);
  }
  lines.push("Use node.invoke with the command + params shown above to call these actions.");
  return lines.join("\n");
}

function notFound(res: ServerResponse) {
  sendJson(res, 404, { ok: false, error: "not found" });
}

function methodNotAllowed(res: ServerResponse) {
  sendJson(res, 405, { ok: false, error: "method not allowed" });
}

export async function startGatewayAdminPipe(params: {
  port: number;
  bindHost: string;
  controlUiEnabled: boolean;
  nodeRegistry: NodeRegistry;
  reloadHandlers: AdminPipeReloadHandlers;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<AdminPipeServer> {
  let lastConfig: OpenClawConfig | null = null;
  let lastSnapshot: ConfigFileSnapshot | null = null;

  const pipePath = resolveAdminPipePath();
  if (process.platform !== "win32" && pipePath.startsWith("/")) {
    try {
      if (fs.existsSync(pipePath)) fs.unlinkSync(pipePath);
    } catch {
      /* ignore */
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/api/v1/status") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const status = {
        ok: true,
        version: VERSION,
        pid: process.pid,
        uptimeSec: Math.floor(process.uptime()),
        port: params.port,
        bindHost: params.bindHost,
        controlUiEnabled: params.controlUiEnabled,
        configPath: CONFIG_PATH,
        nowMs: Date.now(),
      };
      return sendJson(res, 200, status);
    }

    if (url.pathname === "/api/v1/nodes") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const nodes = params.nodeRegistry.listConnected().map((n) => ({
        nodeId: n.nodeId,
        displayName: n.displayName,
        platform: n.platform,
        version: n.version,
        coreVersion: n.coreVersion,
        uiVersion: n.uiVersion,
        deviceFamily: n.deviceFamily,
        modelIdentifier: n.modelIdentifier,
        caps: n.caps,
        commands: n.commands,
        actions: n.actions,
        permissions: n.permissions,
        pathEnv: n.pathEnv,
        connectedAtMs: n.connectedAtMs,
        remoteIp: n.remoteIp,
      }));
      return sendJson(res, 200, { ok: true, nodes });
    }

    if (url.pathname === "/api/v1/nodes/invoke") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const nodeId = typeof body?.nodeId === "string" ? body.nodeId.trim() : "";
      const command = typeof body?.command === "string" ? body.command.trim() : "";
      if (!nodeId || !command) {
        return sendJson(res, 400, { ok: false, error: "nodeId and command are required" });
      }
      const result = await params.nodeRegistry.invoke({
        nodeId,
        command,
        params: body?.params,
        timeoutMs: typeof body?.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    if (url.pathname === "/api/v1/config") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const snapshot = await readConfigFileSnapshot();
      lastSnapshot = snapshot;
      if (snapshot.valid) lastConfig = snapshot.config;
      return sendJson(res, 200, {
        ok: snapshot.valid,
        config: snapshot.valid ? snapshot.config : null,
        issues: snapshot.valid ? [] : snapshot.issues,
      });
    }

    if (url.pathname === "/api/v1/reload") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const snapshot = await readConfigFileSnapshot();
      lastSnapshot = snapshot;
      if (!snapshot.valid) {
        return sendJson(res, 400, { ok: false, error: "invalid config", issues: snapshot.issues });
      }
      const nextConfig = snapshot.config;
      const baseConfig = lastConfig ?? nextConfig;
      lastConfig = nextConfig;

      const changedPaths = diffConfigPaths(baseConfig, nextConfig);
      const settings = resolveGatewayReloadSettings(nextConfig);
      const plan = buildGatewayReloadPlan(changedPaths);

      if (settings.mode === "off") {
        return sendJson(res, 200, {
          ok: true,
          applied: "none",
          reason: "reload disabled",
          plan,
        });
      }

      if (changedPaths.length === 0) {
        return sendJson(res, 200, { ok: true, applied: "noop", plan });
      }

      if (plan.restartGateway || settings.mode === "restart") {
        params.reloadHandlers.requestGatewayRestart(plan, nextConfig);
        return sendJson(res, 200, { ok: true, applied: "restart", plan });
      }

      await params.reloadHandlers.applyHotReload(plan, nextConfig);
      return sendJson(res, 200, { ok: true, applied: "hot", plan });
    }

    if (url.pathname === "/api/v1/shim-test") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const result = await runCowsay();
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    if (url.pathname === "/api/v1/oauth/qwen/start") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const { startQwenOAuth } = await import("./oauth-qwen.js");
      const result = await startQwenOAuth();
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/qwen/poll") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const state = typeof body?.state === "string" ? body.state.trim() : "";
      if (!state) return sendJson(res, 400, { ok: false, error: "state required" });
      const { pollQwenOAuth } = await import("./oauth-qwen.js");
      const result = await pollQwenOAuth(state);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/minimax/start") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const region = typeof body?.region === "string" ? body.region.trim() : "global";
      const { startMiniMaxOAuth } = await import("./oauth-minimax.js");
      const result = await startMiniMaxOAuth(region === "cn" ? "cn" : "global");
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/minimax/poll") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const state = typeof body?.state === "string" ? body.state.trim() : "";
      if (!state) return sendJson(res, 400, { ok: false, error: "state required" });
      const { pollMiniMaxOAuth } = await import("./oauth-minimax.js");
      const result = await pollMiniMaxOAuth(state);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/gemini/start") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const { startGeminiOAuth } = await import("./oauth-gemini.js");
      const result = await startGeminiOAuth();
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/gemini/complete") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const state = typeof body?.state === "string" ? body.state.trim() : "";
      const callbackUrl = typeof body?.callbackUrl === "string" ? body.callbackUrl.trim() : "";
      if (!state || !callbackUrl) return sendJson(res, 400, { ok: false, error: "state and callbackUrl required" });
      const { completeGeminiOAuth } = await import("./oauth-gemini.js");
      const result = await completeGeminiOAuth(state, callbackUrl);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/antigravity/start") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const { startAntigravityOAuth } = await import("./oauth-antigravity.js");
      const result = await startAntigravityOAuth();
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/antigravity/complete") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const state = typeof body?.state === "string" ? body.state.trim() : "";
      const callbackUrl = typeof body?.callbackUrl === "string" ? body.callbackUrl.trim() : "";
      if (!state || !callbackUrl) return sendJson(res, 400, { ok: false, error: "state and callbackUrl required" });
      const { completeAntigravityOAuth } = await import("./oauth-antigravity.js");
      const result = await completeAntigravityOAuth(state, callbackUrl);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/openai/start") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const { startOpenAiOAuth } = await import("./oauth-openai.js");
      const result = await startOpenAiOAuth();
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/openai/complete") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const state = typeof body?.state === "string" ? body.state.trim() : "";
      const callbackUrl = typeof body?.callbackUrl === "string" ? body.callbackUrl.trim() : "";
      if (!state || !callbackUrl) return sendJson(res, 400, { ok: false, error: "state and callbackUrl required" });
      const { completeOpenAiOAuth } = await import("./oauth-openai.js");
      const result = await completeOpenAiOAuth(state, callbackUrl);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/oauth/anthropic/complete") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const token = typeof body?.token === "string" ? body.token.trim() : "";
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!token) return sendJson(res, 400, { ok: false, error: "token required" });
      const { completeAnthropicSetupToken } = await import("./oauth-anthropic.js");
      const result = await completeAnthropicSetupToken({ token, name });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/v1/pairing/list") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { listChannelPairingRequests } = await import("../pairing/pairing-store.js");
      const { resolvePairingChannel } = await import("../channels/plugins/pairing.js");
      try {
        const channel = resolvePairingChannel(body?.channel);
        const requests = await listChannelPairingRequests(channel);
        return sendJson(res, 200, { ok: true, channel, requests });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/pairing/approve") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { approveChannelPairingCode } = await import("../pairing/pairing-store.js");
      const { resolvePairingChannel, notifyPairingApproved } = await import(
        "../channels/plugins/pairing.js"
      );
      const { loadConfig } = await import("../config/config.js");
      try {
        const channel = resolvePairingChannel(body?.channel);
        const code = String(body?.code || "").trim();
        const notify = body?.notify === true;
        const approved = await approveChannelPairingCode({ channel, code });
        if (!approved) {
          return sendJson(res, 400, { ok: false, error: "invalid pairing code" });
        }
        if (notify) {
          const cfg = loadConfig();
          await notifyPairingApproved({ channelId: channel, id: approved.id, cfg });
        }
        return sendJson(res, 200, { ok: true, channel, approved });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/channels/list") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { channelsListCommand } = await import("../commands/channels.js");
      try {
        const payload = await runJsonCommand((runtime) =>
          channelsListCommand({ json: true, usage: body?.usage !== false }, runtime),
        );
        return sendJson(res, 200, { ok: true, ...payload });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/channels/status") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { channelsStatusCommand } = await import("../commands/channels.js");
      try {
        const payload = await runJsonCommand((runtime) =>
          channelsStatusCommand(
            {
              json: true,
              probe: body?.probe === true,
              timeout: typeof body?.timeoutMs === "number" ? String(body.timeoutMs) : undefined,
            },
            runtime,
          ),
        );
        return sendJson(res, 200, { ok: true, ...payload });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/channels/capabilities") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { channelsCapabilitiesCommand } = await import("../commands/channels.js");
      try {
        const payload = await runJsonCommand((runtime) =>
          channelsCapabilitiesCommand(
            {
              json: true,
              channel: body?.channel,
              account: body?.account,
              target: body?.target,
              timeout: typeof body?.timeoutMs === "number" ? String(body.timeoutMs) : undefined,
            },
            runtime,
          ),
        );
        return sendJson(res, 200, { ok: true, ...payload });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/channels/resolve") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { channelsResolveCommand } = await import("../commands/channels.js");
      try {
        const payload = await runJsonCommand((runtime) =>
          channelsResolveCommand(
            {
              json: true,
              channel: body?.channel,
              account: body?.account,
              kind: body?.kind,
              entries: Array.isArray(body?.entries) ? body.entries : [],
            },
            runtime,
          ),
        );
        return sendJson(res, 200, { ok: true, entries: payload });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/channels/logs") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { channelsLogsCommand } = await import("../commands/channels.js");
      try {
        const payload = await runJsonCommand((runtime) =>
          channelsLogsCommand(
            {
              json: true,
              channel: body?.channel,
              lines: body?.lines,
            },
            runtime,
          ),
        );
        return sendJson(res, 200, { ok: true, ...payload });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/channels/add") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { channelsAddCommand } = await import("../commands/channels.js");
      const { listChatChannels } = await import("../channels/registry.js");
      const { listChannelPlugins } = await import("../channels/plugins/index.js");
      const { listChannelPluginCatalogEntries } = await import("../channels/plugins/catalog.js");
      const { resolveAgentWorkspaceDir, resolveDefaultAgentId } = await import("../agents/agent-scope.js");
      const { loadConfig } = await import("../config/config.js");
      const { loadOpenClawPlugins } = await import("../plugins/loader.js");
      const { discoverOpenClawPlugins } = await import("../plugins/discovery.js");
      const { resolveBundledPluginsDir } = await import("../plugins/bundled-dir.js");
      const channelInput = typeof body?.channel === "string" ? body.channel.trim() : "";
      const availableChannels = listChatChannels().map((entry: any) => entry.id);
      if (!channelInput) {
        return sendJson(res, 400, {
          ok: false,
          error: "channel is required",
          availableChannels,
        });
      }
      let installedChannels = listChannelPlugins().map((p: any) => p.id);
      let pluginDiagnostics: unknown[] | undefined;
      let pluginDiscovery: { bundledDir?: string; candidates?: string[] } | undefined;
      if (installedChannels.length === 0) {
        try {
          const cfg = loadConfig();
          const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
          const registry = loadOpenClawPlugins({ config: cfg, workspaceDir });
          installedChannels = registry.channels.map((entry: any) => entry.plugin.id);
          pluginDiagnostics = registry.diagnostics;
          const discovery = discoverOpenClawPlugins({ workspaceDir });
          pluginDiscovery = {
            bundledDir: resolveBundledPluginsDir(),
            candidates: discovery.candidates.map((c: any) => c.idHint),
          };
        } catch (err) {
          pluginDiagnostics = [{ level: "error", message: String(err) }];
          pluginDiscovery = { bundledDir: resolveBundledPluginsDir(), candidates: [] };
        }
      }
      if (!installedChannels.includes(channelInput)) {
        const cfg = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
        const catalogChannels = listChannelPluginCatalogEntries({ workspaceDir }).map((entry: any) => entry.id);
        if (pluginDiscovery?.candidates?.includes(channelInput)) {
          const allow = Array.isArray(cfg.plugins?.allow) ? cfg.plugins?.allow : undefined;
          const nextAllow = allow && !allow.includes(channelInput) ? [...allow, channelInput] : allow;
          const nextConfig = {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              ...(cfg.plugins?.enabled === false ? { enabled: true } : {}),
              ...(nextAllow ? { allow: nextAllow } : {}),
              entries: {
                ...cfg.plugins?.entries,
                [channelInput]: {
                  ...(cfg.plugins?.entries?.[channelInput] ?? {}),
                  enabled: true,
                },
              },
            },
          };
          await writeConfigFile(nextConfig);
          const registry = loadOpenClawPlugins({ config: nextConfig, workspaceDir });
          installedChannels = registry.channels.map((entry: any) => entry.plugin.id);
          pluginDiagnostics = registry.diagnostics;
        }
        if (!installedChannels.includes(channelInput)) {
          return sendJson(res, 400, {
            ok: false,
            error: `channel plugin not installed: ${channelInput}`,
            availableChannels,
            installedChannels,
            catalogChannels,
            pluginDiagnostics,
            pluginDiscovery,
          });
        }
      }
      let lastRuntimeError = "";
      try {
        await channelsAddCommand(
          body as any,
          {
            ...defaultRuntime,
            error: (...args) => {
              lastRuntimeError = args.map((entry) => String(entry)).join(" ");
              defaultRuntime.error(...args);
            },
            exit: () => {
              throw new Error("runtime.exit");
            },
          },
          { hasFlags: true },
        );
        return sendJson(res, 200, { ok: true, action: "channels.add" });
      } catch (err) {
        return sendJson(res, 400, {
          ok: false,
          error: lastRuntimeError || String(err),
          availableChannels,
          installedChannels,
        });
      }
    }

    if (url.pathname === "/api/v1/channels/remove") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { channelsRemoveCommand } = await import("../commands/channels.js");
      try {
        await channelsRemoveCommand(body as any, { ...defaultRuntime, exit: () => { throw new Error("runtime.exit"); } }, { hasFlags: true });
        return sendJson(res, 200, { ok: true, action: "channels.remove" });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/channels/login") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { runChannelLogin } = await import("../cli/channel-auth.js");
      const { listChatChannels } = await import("../channels/registry.js");
      const { listChannelPlugins } = await import("../channels/plugins/index.js");
      const { listChannelPluginCatalogEntries } = await import("../channels/plugins/catalog.js");
      const { resolveAgentWorkspaceDir, resolveDefaultAgentId } = await import("../agents/agent-scope.js");
      const { loadConfig } = await import("../config/config.js");
      const { loadOpenClawPlugins } = await import("../plugins/loader.js");
      const { discoverOpenClawPlugins } = await import("../plugins/discovery.js");
      const { resolveBundledPluginsDir } = await import("../plugins/bundled-dir.js");
      const channelInput = typeof body?.channel === "string" ? body.channel.trim() : "";
      const availableChannels = listChatChannels().map((entry: any) => entry.id);
      if (!channelInput) {
        return sendJson(res, 400, {
          ok: false,
          error: "channel is required",
          availableChannels,
        });
      }
      let installedChannels = listChannelPlugins().map((p: any) => p.id);
      let pluginDiagnostics: unknown[] | undefined;
      let pluginDiscovery: { bundledDir?: string; candidates?: string[] } | undefined;
      if (installedChannels.length === 0) {
        try {
          const cfg = loadConfig();
          const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
          const registry = loadOpenClawPlugins({ config: cfg, workspaceDir });
          installedChannels = registry.channels.map((entry: any) => entry.plugin.id);
          pluginDiagnostics = registry.diagnostics;
          const discovery = discoverOpenClawPlugins({ workspaceDir });
          pluginDiscovery = {
            bundledDir: resolveBundledPluginsDir(),
            candidates: discovery.candidates.map((c: any) => c.idHint),
          };
        } catch (err) {
          pluginDiagnostics = [{ level: "error", message: String(err) }];
          pluginDiscovery = { bundledDir: resolveBundledPluginsDir(), candidates: [] };
        }
      }
      if (!installedChannels.includes(channelInput)) {
        const cfg = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
        const catalogChannels = listChannelPluginCatalogEntries({ workspaceDir }).map((entry: any) => entry.id);
        if (pluginDiscovery?.candidates?.includes(channelInput)) {
          const allow = Array.isArray(cfg.plugins?.allow) ? cfg.plugins?.allow : undefined;
          const nextAllow = allow && !allow.includes(channelInput) ? [...allow, channelInput] : allow;
          const nextConfig = {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              ...(cfg.plugins?.enabled === false ? { enabled: true } : {}),
              ...(nextAllow ? { allow: nextAllow } : {}),
              entries: {
                ...cfg.plugins?.entries,
                [channelInput]: {
                  ...(cfg.plugins?.entries?.[channelInput] ?? {}),
                  enabled: true,
                },
              },
            },
          };
          await writeConfigFile(nextConfig);
          const registry = loadOpenClawPlugins({ config: nextConfig, workspaceDir });
          installedChannels = registry.channels.map((entry: any) => entry.plugin.id);
          pluginDiagnostics = registry.diagnostics;
        }
        if (!installedChannels.includes(channelInput)) {
          return sendJson(res, 400, {
            ok: false,
            error: `channel plugin not installed: ${channelInput}`,
            availableChannels,
            installedChannels,
            catalogChannels,
            pluginDiagnostics,
            pluginDiscovery,
          });
        }
      }
      try {
        await runChannelLogin(body as any, { ...defaultRuntime, exit: () => { throw new Error("runtime.exit"); } });
        return sendJson(res, 200, { ok: true, action: "channels.login" });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/channels/logout") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const { runChannelLogout } = await import("../cli/channel-auth.js");
      try {
        await runChannelLogout(body as any, { ...defaultRuntime, exit: () => { throw new Error("runtime.exit"); } });
        return sendJson(res, 200, { ok: true, action: "channels.logout" });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }

    if (url.pathname === "/api/v1/agent") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const message = typeof body?.message === "string" ? body.message.trim() : "";
      const sessionKey = typeof body?.sessionKey === "string" ? body.sessionKey.trim() : "";
      if (!message) return sendJson(res, 400, { ok: false, error: "message required" });
      try {
        const toolsPrompt = buildToolsPrompt(params.nodeRegistry);
        const lowered = message.toLowerCase();
        const isToolsQuery = lowered.includes("tools") || lowered.includes("actions") || lowered.includes("可用") || lowered.includes("工具");
        if (isToolsQuery && toolsPrompt) {
          return sendJson(res, 200, { ok: true, texts: [toolsPrompt] });
        }
        const policyPrompt =
          "When describing available tools or actions, ONLY use the tools.list data below. Do not list any internal/system tools.";
        const extraSystemPrompt = toolsPrompt
          ? `${policyPrompt}\n\n${toolsPrompt}`
          : policyPrompt;
        const result = await agentCommand(
          {
            message,
            sessionKey: sessionKey || "desktop-chat",
            to: "desktop-chat",
            deliver: false,
            extraSystemPrompt,
          },
          defaultRuntime,
        );
        const texts = extractAssistantTexts(result);
        return sendJson(res, 200, { ok: true, texts });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err) });
      }
    }

    return notFound(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => resolve());
  });

  params.log.info(`admin pipe listening: ${pipePath}`);

  return {
    path: pipePath,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      if (process.platform !== "win32" && pipePath.startsWith("/")) {
        try {
          if (fs.existsSync(pipePath)) fs.unlinkSync(pipePath);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

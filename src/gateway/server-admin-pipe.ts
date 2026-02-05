import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { agentCommand } from "../commands/agent.js";
import { defaultRuntime } from "../runtime.js";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/config.js";
import type { NodeRegistry } from "./node-registry.js";
import { CONFIG_PATH, readConfigFileSnapshot } from "../config/config.js";
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

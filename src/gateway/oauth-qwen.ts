import { randomUUID } from "node:crypto";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveDefaultAgentId, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  type QwenDeviceAuthorization,
  type QwenOAuthToken,
  requestQwenDeviceCode,
  pollQwenDeviceToken,
  generateQwenPkce,
} from "../../extensions/qwen-portal-auth/oauth.js";

const PROVIDER_ID = "qwen-portal";
const DEFAULT_MODEL = "qwen-portal/coder-model";
const DEFAULT_BASE_URL = "https://portal.qwen.ai/v1";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;
const OAUTH_PLACEHOLDER = "qwen-oauth";

type QwenSession = {
  state: string;
  device: QwenDeviceAuthorization;
  verifier: string;
  expiresAtMs: number;
  intervalMs: number;
};

const sessions = new Map<string, QwenSession>();

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProtocol.endsWith("/v1") ? withProtocol : `${withProtocol.replace(/\/+$/, "")}/v1`;
}

function buildModelDefinition(params: { id: string; name: string; input: Array<"text" | "image"> }) {
  return {
    id: params.id,
    name: params.name,
    reasoning: false,
    input: params.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function mergeConfigPatch<T>(base: T, patch: unknown): T {
  if (!base || typeof base !== "object" || Array.isArray(base)) return patch as T;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const existing = next[key];
    if (existing && typeof existing === "object" && !Array.isArray(existing) && value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = mergeConfigPatch(existing, value);
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

function applyDefaultModel(cfg: any, model: string) {
  const models = { ...(cfg.agents?.defaults?.models ?? {}) };
  models[model] = models[model] ?? {};
  const existingModel = cfg.agents?.defaults?.model;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
            ? { fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks }
            : undefined),
          primary: model,
        },
      },
    },
  };
}

async function writeQwenConfig(token: QwenOAuthToken) {
  const cfg = loadConfig();
  const baseUrl = normalizeBaseUrl(token.resourceUrl);
  const configPatch = {
    models: {
      providers: {
        [PROVIDER_ID]: {
          baseUrl,
          apiKey: OAUTH_PLACEHOLDER,
          api: "openai-completions",
          models: [
            buildModelDefinition({ id: "coder-model", name: "Qwen Coder", input: ["text"] }),
            buildModelDefinition({ id: "vision-model", name: "Qwen Vision", input: ["text", "image"] }),
          ],
        },
      },
    },
    agents: {
      defaults: {
        models: {
          "qwen-portal/coder-model": { alias: "qwen" },
          "qwen-portal/vision-model": {},
        },
      },
    },
  };

  const nextConfig = mergeConfigPatch(cfg, configPatch);
  const agentId = resolveDefaultAgentId(nextConfig);
  const agentDir = agentId === resolveDefaultAgentId(nextConfig) ? resolveOpenClawAgentDir() : resolveAgentDir(nextConfig, agentId);

  upsertAuthProfile({
    profileId: `${PROVIDER_ID}:default`,
    credential: {
      type: "oauth",
      provider: normalizeProviderId(PROVIDER_ID),
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
    },
    agentDir,
  });

  let finalConfig = applyAuthProfileConfig(nextConfig, {
    profileId: `${PROVIDER_ID}:default`,
    provider: normalizeProviderId(PROVIDER_ID),
    mode: "oauth",
  });

  finalConfig = applyDefaultModel(finalConfig, DEFAULT_MODEL);
  await writeConfigFile(finalConfig);
  return finalConfig;
}

export async function startQwenOAuth() {
  const { verifier, challenge } = generateQwenPkce();
  const device = await requestQwenDeviceCode({ challenge });
  const state = randomUUID();
  const intervalMs = (device.interval ? device.interval : 2) * 1000;
  const expiresAtMs = Date.now() + device.expires_in * 1000;
  sessions.set(state, { state, device, verifier, intervalMs, expiresAtMs });
  return {
    state,
    verificationUrl: device.verification_uri_complete || device.verification_uri,
    userCode: device.user_code,
    intervalMs,
    expiresAtMs,
  };
}

export async function pollQwenOAuth(state: string) {
  const session = sessions.get(state);
  if (!session) {
    return { status: "error" as const, error: "invalid_state" };
  }
  if (Date.now() > session.expiresAtMs) {
    sessions.delete(state);
    return { status: "expired" as const };
  }
  const result = await pollQwenDeviceToken({
    deviceCode: session.device.device_code,
    verifier: session.verifier,
  });
  if (result.status === "pending") {
    return { status: "pending" as const };
  }
  if (result.status === "error") {
    return { status: "error" as const, error: result.message };
  }
  await writeQwenConfig(result.token);
  sessions.delete(state);
  return { status: "success" as const };
}

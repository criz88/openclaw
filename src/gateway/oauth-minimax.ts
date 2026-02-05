import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveDefaultAgentId, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  type MiniMaxOAuthAuthorization,
  type MiniMaxOAuthToken,
  generateMiniMaxPkce,
  requestMiniMaxOAuthCode,
  pollMiniMaxOAuthToken,
} from "../../extensions/minimax-portal-auth/oauth.js";

const PROVIDER_ID = "minimax-portal";
const DEFAULT_MODEL = "MiniMax-M2.1";
const DEFAULT_BASE_URL_CN = "https://api.minimaxi.com/anthropic";
const DEFAULT_BASE_URL_GLOBAL = "https://api.minimax.io/anthropic";
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 8192;
const OAUTH_PLACEHOLDER = "minimax-oauth";

type MiniMaxRegion = "cn" | "global";

type MiniMaxSession = {
  state: string;
  region: MiniMaxRegion;
  auth: MiniMaxOAuthAuthorization;
  verifier: string;
  expiresAtMs: number;
  intervalMs: number;
};

const sessions = new Map<string, MiniMaxSession>();

function getDefaultBaseUrl(region: MiniMaxRegion): string {
  return region === "cn" ? DEFAULT_BASE_URL_CN : DEFAULT_BASE_URL_GLOBAL;
}

function modelRef(modelId: string): string {
  return `${PROVIDER_ID}/${modelId}`;
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

async function writeMiniMaxConfig(token: MiniMaxOAuthToken, region: MiniMaxRegion) {
  const cfg = loadConfig();
  const baseUrl = token.resourceUrl || getDefaultBaseUrl(region);
  const configPatch = {
    models: {
      providers: {
        [PROVIDER_ID]: {
          baseUrl,
          apiKey: OAUTH_PLACEHOLDER,
          api: "anthropic-messages",
          models: [
            buildModelDefinition({ id: "MiniMax-M2.1", name: "MiniMax M2.1", input: ["text"] }),
            buildModelDefinition({ id: "MiniMax-M2.1-lightning", name: "MiniMax M2.1 Lightning", input: ["text"] }),
          ],
        },
      },
    },
    agents: {
      defaults: {
        models: {
          [modelRef("MiniMax-M2.1")]: { alias: "minimax-m2.1" },
          [modelRef("MiniMax-M2.1-lightning")]: { alias: "minimax-m2.1-lightning" },
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

  finalConfig = applyDefaultModel(finalConfig, modelRef(DEFAULT_MODEL));
  await writeConfigFile(finalConfig);
  return finalConfig;
}

export async function startMiniMaxOAuth(region: MiniMaxRegion = "global") {
  const { verifier, challenge, state } = generateMiniMaxPkce();
  const auth = await requestMiniMaxOAuthCode({ challenge, state, region });
  const intervalMs = (auth.interval ? auth.interval : 2) * 1000;
  const expiresAtMs = Date.now() + auth.expired_in * 1000;
  sessions.set(state, { state, region, auth, verifier, intervalMs, expiresAtMs });
  return {
    state,
    verificationUrl: auth.verification_uri,
    userCode: auth.user_code,
    intervalMs,
    expiresAtMs,
  };
}

export async function pollMiniMaxOAuth(state: string) {
  const session = sessions.get(state);
  if (!session) return { status: "error" as const, error: "invalid_state" };
  if (Date.now() > session.expiresAtMs) {
    sessions.delete(state);
    return { status: "expired" as const };
  }
  const result = await pollMiniMaxOAuthToken({
    userCode: session.auth.user_code,
    verifier: session.verifier,
    region: session.region,
  });
  if (result.status === "pending") {
    return { status: "pending" as const, message: result.message };
  }
  if (result.status === "error") {
    return { status: "error" as const, error: result.message };
  }
  await writeMiniMaxConfig(result.token, session.region);
  sessions.delete(state);
  return { status: "success" as const };
}

import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveDefaultAgentId, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  generateAntigravityPkce,
  buildAntigravityAuthUrl,
  parseAntigravityCallbackInput,
  exchangeAntigravityCode,
  fetchAntigravityUserEmail,
  fetchAntigravityProjectId,
} from "../../extensions/google-antigravity-auth/index.js";

const PROVIDER_ID = "google-antigravity";
const DEFAULT_MODEL = "google-antigravity/claude-opus-4-5-thinking";

type AntigravitySession = {
  state: string;
  verifier: string;
};

const sessions = new Map<string, AntigravitySession>();

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

async function writeAntigravityConfig(token: { access: string; refresh: string; expires: number; email?: string; projectId: string }) {
  const cfg = loadConfig();
  const configPatch = {
    agents: {
      defaults: {
        models: {
          [DEFAULT_MODEL]: {},
        },
      },
    },
  };

  const nextConfig = mergeConfigPatch(cfg, configPatch);
  const agentId = resolveDefaultAgentId(nextConfig);
  const agentDir = agentId === resolveDefaultAgentId(nextConfig) ? resolveOpenClawAgentDir() : resolveAgentDir(nextConfig, agentId);

  const profileId = `google-antigravity:${token.email ?? "default"}`;
  upsertAuthProfile({
    profileId,
    credential: {
      type: "oauth",
      provider: normalizeProviderId(PROVIDER_ID),
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
      email: token.email,
      projectId: token.projectId,
    },
    agentDir,
  });

  let finalConfig = applyAuthProfileConfig(nextConfig, {
    profileId,
    provider: normalizeProviderId(PROVIDER_ID),
    mode: "oauth",
  });

  finalConfig = applyDefaultModel(finalConfig, DEFAULT_MODEL);
  await writeConfigFile(finalConfig);
  return finalConfig;
}

export async function startAntigravityOAuth() {
  const { verifier, challenge } = generateAntigravityPkce();
  const state = verifier;
  const authUrl = buildAntigravityAuthUrl({ challenge, state });
  sessions.set(state, { state, verifier });
  return { state, authUrl, redirectUri: "http://localhost:51121/oauth-callback" };
}

export async function completeAntigravityOAuth(state: string, callbackUrl: string) {
  const session = sessions.get(state);
  if (!session) return { status: "error" as const, error: "invalid_state" };
  const parsed = parseAntigravityCallbackInput(callbackUrl);
  if ("error" in parsed) return { status: "error" as const, error: parsed.error };
  if (parsed.state !== session.state) return { status: "error" as const, error: "state_mismatch" };
  const tokens = await exchangeAntigravityCode({ code: parsed.code, verifier: session.verifier });
  const email = await fetchAntigravityUserEmail(tokens.access);
  const projectId = await fetchAntigravityProjectId(tokens.access);
  await writeAntigravityConfig({ ...tokens, email, projectId });
  sessions.delete(state);
  return { status: "success" as const };
}

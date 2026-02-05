import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveDefaultAgentId, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "../commands/auth-token.js";

export async function completeAnthropicSetupToken(params: { token: string; name?: string }) {
  const token = params.token.trim();
  const error = validateAnthropicSetupToken(token);
  if (error) return { status: "error" as const, error };

  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = agentId === resolveDefaultAgentId(cfg) ? resolveOpenClawAgentDir() : resolveAgentDir(cfg, agentId);
  const profileId = buildTokenProfileId({ provider: "anthropic", name: params.name ?? "" });

  upsertAuthProfile({
    profileId,
    agentDir,
    credential: {
      type: "token",
      provider: "anthropic",
      token,
    },
  });

  const nextConfig = applyAuthProfileConfig(cfg, {
    profileId,
    provider: "anthropic",
    mode: "token",
  });
  await writeConfigFile(nextConfig);
  return { status: "success" as const };
}

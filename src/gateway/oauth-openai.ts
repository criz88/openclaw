import { randomUUID } from "node:crypto";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveDefaultAgentId, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { applyAuthProfileConfig, writeOAuthCredentials } from "../commands/onboard-auth.js";
import { applyOpenAICodexModelDefault, OPENAI_CODEX_DEFAULT_MODEL } from "../commands/openai-codex-model-default.js";
import { loginOpenAICodex } from "@mariozechner/pi-ai";

const sessions = new Map<
  string,
  {
    promptResolve: (value: string) => void;
    runPromise: Promise<void>;
    authUrlPromise: Promise<string>;
    authUrlResolve: (url: string) => void;
  }
>();

async function writeOpenAiConfig(creds: any) {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = agentId === resolveDefaultAgentId(cfg) ? resolveOpenClawAgentDir() : resolveAgentDir(cfg, agentId);
  await writeOAuthCredentials("openai-codex", creds, agentDir);
  let nextConfig = applyAuthProfileConfig(cfg, {
    profileId: "openai-codex:default",
    provider: "openai-codex",
    mode: "oauth",
  });
  const applied = applyOpenAICodexModelDefault(nextConfig);
  nextConfig = applied.next;
  await writeConfigFile(nextConfig);
}

export async function startOpenAiOAuth() {
  const state = randomUUID();
  let promptResolve!: (value: string) => void;
  const promptPromise = new Promise<string>((resolve) => (promptResolve = resolve));
  let authUrlResolve!: (url: string) => void;
  const authUrlPromise = new Promise<string>((resolve) => (authUrlResolve = resolve));

  const runPromise = loginOpenAICodex({
    onAuth: async ({ url }: { url: string }) => {
      authUrlResolve(url);
    },
    onPrompt: async () => {
      return await promptPromise;
    },
    onProgress: () => {},
  })
    .then((creds: any) => {
      if (creds) {
        return writeOpenAiConfig(creds);
      }
    })
    .finally(() => {
      sessions.delete(state);
    });

  sessions.set(state, { promptResolve, runPromise, authUrlPromise, authUrlResolve });
  const authUrl = await authUrlPromise;
  return { state, authUrl, redirectHint: "Paste the full redirect URL after login" };
}

export async function completeOpenAiOAuth(state: string, callbackUrl: string) {
  const session = sessions.get(state);
  if (!session) return { status: "error" as const, error: "invalid_state" };
  session.promptResolve(callbackUrl);
  await session.runPromise;
  return { status: "success" as const };
}

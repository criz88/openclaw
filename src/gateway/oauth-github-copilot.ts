import { randomUUID } from "node:crypto";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { updateConfig } from "../commands/models/shared.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";

const PROVIDER_ID = "github-copilot";
const DEFAULT_PROFILE_ID = "github-copilot:github";

// Keep these in sync with providers/github-copilot-auth.ts (CLI device-login).
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type DeviceTokenResponse =
  | {
      access_token: string;
      token_type: string;
      scope?: string;
    }
  | {
      error: string;
      error_description?: string;
      error_uri?: string;
    };

type CopilotSession = {
  state: string;
  profileId: string;
  deviceCode: string;
  expiresAtMs: number;
  intervalMs: number;
};

const sessions = new Map<string, CopilotSession>();

function parseJsonResponse<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub");
  }
  return value as T;
}

async function requestDeviceCode(params: { scope: string }): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: params.scope,
  });

  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device code failed: HTTP ${res.status}`);
  }

  const json = parseJsonResponse<DeviceCodeResponse>(await res.json());
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("GitHub device code response missing fields");
  }
  return json;
}

async function requestAccessTokenOnce(params: {
  deviceCode: string;
}): Promise<
  | { status: "success"; accessToken: string }
  | { status: "pending"; slowDown?: boolean }
  | { status: "expired" }
  | { status: "error"; error: string }
> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    return { status: "error", error: `GitHub device token failed: HTTP ${res.status}` };
  }

  const json = parseJsonResponse<DeviceTokenResponse>(await res.json());
  if ("access_token" in json && typeof json.access_token === "string") {
    return { status: "success", accessToken: json.access_token };
  }

  const err = "error" in json ? json.error : "unknown";
  if (err === "authorization_pending") {
    return { status: "pending" };
  }
  if (err === "slow_down") {
    return { status: "pending", slowDown: true };
  }
  if (err === "expired_token") {
    return { status: "expired" };
  }
  if (err === "access_denied") {
    return { status: "error", error: "GitHub login cancelled" };
  }
  return { status: "error", error: `GitHub device flow error: ${err}` };
}

export async function startGitHubCopilotOAuth(opts?: { profileId?: string }) {
  const profileId = String(opts?.profileId || "").trim() || DEFAULT_PROFILE_ID;

  const device = await requestDeviceCode({ scope: "read:user" });
  const state = randomUUID();
  const intervalMs = Math.max(1000, device.interval * 1000);
  const expiresAtMs = Date.now() + device.expires_in * 1000;

  sessions.set(state, {
    state,
    profileId,
    deviceCode: device.device_code,
    intervalMs,
    expiresAtMs,
  });

  return {
    state,
    verificationUrl: device.verification_uri,
    userCode: device.user_code,
    intervalMs,
    expiresAtMs,
  };
}

export async function pollGitHubCopilotOAuth(state: string) {
  const session = sessions.get(state);
  if (!session) {
    return { status: "error" as const, error: "invalid_state" };
  }
  if (Date.now() > session.expiresAtMs) {
    sessions.delete(state);
    return { status: "expired" as const };
  }

  const result = await requestAccessTokenOnce({ deviceCode: session.deviceCode });
  if (result.status === "pending") {
    if (result.slowDown) {
      // GitHub asks to slow polling; teach the client via response.
      session.intervalMs = session.intervalMs + 2000;
      sessions.set(state, session);
      return { status: "pending" as const, intervalMs: session.intervalMs };
    }
    return { status: "pending" as const };
  }
  if (result.status === "expired") {
    sessions.delete(state);
    return { status: "expired" as const };
  }
  if (result.status === "error") {
    sessions.delete(state);
    return { status: "error" as const, error: result.error };
  }

  upsertAuthProfile({
    profileId: session.profileId,
    credential: {
      type: "token",
      provider: PROVIDER_ID,
      token: result.accessToken,
    },
  });

  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      provider: PROVIDER_ID,
      profileId: session.profileId,
      mode: "token",
    }),
  );

  sessions.delete(state);
  return { status: "success" as const, profileId: session.profileId };
}

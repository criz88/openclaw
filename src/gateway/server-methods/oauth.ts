import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { startQwenOAuth, pollQwenOAuth } from "../oauth-qwen.js";
import { startMiniMaxOAuth, pollMiniMaxOAuth } from "../oauth-minimax.js";
import { startGeminiOAuth, completeGeminiOAuth } from "../oauth-gemini.js";
import { startAntigravityOAuth, completeAntigravityOAuth } from "../oauth-antigravity.js";
import { startOpenAiOAuth, completeOpenAiOAuth } from "../oauth-openai.js";
import { completeAnthropicSetupToken } from "../oauth-anthropic.js";

export const oauthHandlers: GatewayRequestHandlers = {
  "oauth.qwen.start": async ({ respond }) => {
    try {
      const res = await startQwenOAuth();
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.qwen.poll": async ({ params, respond, context }) => {
    const state = typeof (params as any)?.state === "string" ? (params as any).state.trim() : "";
    if (!state) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "state required"));
      return;
    }
    try {
      const res = await pollQwenOAuth(state);
      if (res.status === "success") {
        context.broadcast("oauth.updated", { provider: "qwen-portal", ok: true }, { dropIfSlow: true });
      }
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.minimax.start": async ({ params, respond }) => {
    try {
      const regionRaw = typeof (params as any)?.region === "string" ? (params as any).region.trim() : "global";
      const region = regionRaw === "cn" ? "cn" : "global";
      const res = await startMiniMaxOAuth(region);
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.minimax.poll": async ({ params, respond, context }) => {
    const state = typeof (params as any)?.state === "string" ? (params as any).state.trim() : "";
    if (!state) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "state required"));
      return;
    }
    try {
      const res = await pollMiniMaxOAuth(state);
      if (res.status === "success") {
        context.broadcast("oauth.updated", { provider: "minimax-portal", ok: true }, { dropIfSlow: true });
      }
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.gemini.start": async ({ respond }) => {
    try {
      const res = await startGeminiOAuth();
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.gemini.complete": async ({ params, respond, context }) => {
    const state = typeof (params as any)?.state === "string" ? (params as any).state.trim() : "";
    const callbackUrl = typeof (params as any)?.callbackUrl === "string" ? (params as any).callbackUrl.trim() : "";
    if (!state || !callbackUrl) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "state and callbackUrl required"));
      return;
    }
    try {
      const res = await completeGeminiOAuth(state, callbackUrl);
      if (res.status === "success") {
        context.broadcast("oauth.updated", { provider: "google-gemini-cli", ok: true }, { dropIfSlow: true });
      }
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.antigravity.start": async ({ respond }) => {
    try {
      const res = await startAntigravityOAuth();
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.antigravity.complete": async ({ params, respond, context }) => {
    const state = typeof (params as any)?.state === "string" ? (params as any).state.trim() : "";
    const callbackUrl = typeof (params as any)?.callbackUrl === "string" ? (params as any).callbackUrl.trim() : "";
    if (!state || !callbackUrl) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "state and callbackUrl required"));
      return;
    }
    try {
      const res = await completeAntigravityOAuth(state, callbackUrl);
      if (res.status === "success") {
        context.broadcast("oauth.updated", { provider: "google-antigravity", ok: true }, { dropIfSlow: true });
      }
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.openai.start": async ({ respond }) => {
    try {
      const res = await startOpenAiOAuth();
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.openai.complete": async ({ params, respond, context }) => {
    const state = typeof (params as any)?.state === "string" ? (params as any).state.trim() : "";
    const callbackUrl = typeof (params as any)?.callbackUrl === "string" ? (params as any).callbackUrl.trim() : "";
    if (!state || !callbackUrl) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "state and callbackUrl required"));
      return;
    }
    try {
      const res = await completeOpenAiOAuth(state, callbackUrl);
      if (res.status === "success") {
        context.broadcast("oauth.updated", { provider: "openai-codex", ok: true }, { dropIfSlow: true });
      }
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "oauth.anthropic.complete": async ({ params, respond, context }) => {
    const token = typeof (params as any)?.token === "string" ? (params as any).token.trim() : "";
    const name = typeof (params as any)?.name === "string" ? (params as any).name.trim() : "";
    if (!token) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "token required"));
      return;
    }
    try {
      const res = await completeAnthropicSetupToken({ token, name });
      if (res.status === "success") {
        context.broadcast("oauth.updated", { provider: "anthropic", ok: true }, { dropIfSlow: true });
      }
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};

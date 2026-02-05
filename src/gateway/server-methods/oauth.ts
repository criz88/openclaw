import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { startQwenOAuth, pollQwenOAuth } from "../oauth-qwen.js";

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
};

import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { resolveConfiguredModelRef } from "../../agents/model-selection.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { runAuthProbes, describeProbeSummary, sortProbeResults } from "../../commands/models/list.probe.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
  validateModelsTestParams,
} from "../protocol/index.js";

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const models = await context.loadGatewayModelCatalog();
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.test": async ({ params, respond }) => {
    if (!validateModelsTestParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.test params: ${formatValidationErrors(validateModelsTestParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    const modelLabel = `${resolved.provider}/${resolved.model}`;
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 15_000;
    const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : 64;
    try {
      const summary = await runAuthProbes({
        cfg,
        providers: [resolved.provider],
        modelCandidates: [modelLabel],
        options: {
          timeoutMs,
          maxTokens,
          concurrency: 1,
          providersOnly: false,
        },
      });
      const results = sortProbeResults(summary.results);
      const ok = results.length > 0 && results.every((entry) => entry.status === "ok");
      respond(
        true,
        {
          ok,
          summary: describeProbeSummary(summary),
          durationMs: summary.durationMs,
          results,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};

import {
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  writeConfigFile,
} from "../../config/config.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { readMcpHubConfig, writeMcpHubConfig, normalizeMcpProviderId, buildMcpSecretRef } from "../../mcp/config.js";
import { findMcpPresetByProviderId, findMcpPresetByPresetId, listMcpPresets } from "../../mcp/presets.js";
import { deleteSecret, hasSecret, setSecret } from "../../mcp/secret-store.js";
import { formatValidationErrors, validateMcpPresetsListParams, validateMcpProvidersApplyParams, validateMcpProvidersSnapshotParams } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { listToolDefinitions } from "./tools.js";

type McpFieldError = {
  providerId: string;
  field: string;
  message: string;
};

function resolveBaseHash(params: Record<string, unknown>): string | null {
  const raw = params?.baseHash;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed || null;
}

function requireConfigBaseHash(
  params: Record<string, unknown>,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): { ok: true } | { ok: false; error: string } {
  if (!snapshot.exists) {
    return { ok: true };
  }
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    return {
      ok: false,
      error: "config base hash unavailable; re-run mcp.providers.snapshot and retry",
    };
  }
  const baseHash = resolveBaseHash(params);
  if (!baseHash) {
    return {
      ok: false,
      error: "config base hash required; re-run mcp.providers.snapshot and retry",
    };
  }
  if (baseHash !== snapshotHash) {
    return {
      ok: false,
      error: "config changed since last load; re-run mcp.providers.snapshot and retry",
    };
  }
  return { ok: true };
}

function buildMcpSnapshotRows(params: {
  providersConfig: ReturnType<typeof readMcpHubConfig>["providers"];
  toolDefinitions: ReturnType<typeof listToolDefinitions>;
}) {
  const presets = listMcpPresets();
  const presetsByProviderId = new Map(presets.map((preset) => [preset.providerId, preset] as const));
  const toolCountByProviderId = new Map<string, number>();
  for (const definition of params.toolDefinitions) {
    if (definition.providerKind !== "mcp") continue;
    const providerId = normalizeMcpProviderId(definition.providerId);
    if (!providerId) continue;
    toolCountByProviderId.set(providerId, (toolCountByProviderId.get(providerId) || 0) + 1);
  }

  const rows: Array<Record<string, unknown>> = [];

  for (const preset of presets) {
    const providerId = preset.providerId;
    const cfg = params.providersConfig[providerId];
    const toolCount = toolCountByProviderId.get(providerId) || 0;
    const secretRefs = cfg?.secretRefs || {};
    const secretState: Record<string, boolean> = {};
    for (const [fieldKey, secretRef] of Object.entries(secretRefs)) {
      secretState[fieldKey] = hasSecret(secretRef);
    }
    rows.push({
      providerId,
      presetId: preset.presetId,
      label: cfg?.label || preset.label,
      configured: Boolean(cfg),
      enabled: cfg?.enabled === true,
      available: toolCount > 0,
      toolCount,
      iconKey: preset.iconKey,
      description: preset.description,
      fields: cfg?.fields || {},
      region: cfg?.region || "",
      workspace: cfg?.workspace || "",
      scopes: cfg?.scopes || [],
      secretState,
      updatedAt: cfg?.updatedAt || "",
    });
  }

  for (const [providerId, cfg] of Object.entries(params.providersConfig)) {
    if (presetsByProviderId.has(providerId)) continue;
    const toolCount = toolCountByProviderId.get(providerId) || 0;
    const secretRefs = cfg?.secretRefs || {};
    const secretState: Record<string, boolean> = {};
    for (const [fieldKey, secretRef] of Object.entries(secretRefs)) {
      secretState[fieldKey] = hasSecret(secretRef);
    }
    rows.push({
      providerId,
      presetId: cfg.presetId,
      label: cfg.label || providerId,
      configured: true,
      enabled: cfg.enabled === true,
      available: toolCount > 0,
      toolCount,
      iconKey: "",
      description: "",
      fields: cfg.fields || {},
      region: cfg.region || "",
      workspace: cfg.workspace || "",
      scopes: cfg.scopes || [],
      secretState,
      updatedAt: cfg.updatedAt || "",
    });
  }

  return rows.sort((a, b) =>
    String(a.label || a.providerId || "").localeCompare(String(b.label || b.providerId || "")),
  );
}

export const mcpHandlers: GatewayRequestHandlers = {
  "mcp.presets.list": ({ params, respond }) => {
    if (!validateMcpPresetsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.presets.list params: ${formatValidationErrors(validateMcpPresetsListParams.errors)}`,
        ),
      );
      return;
    }
    respond(true, { ok: true, presets: listMcpPresets() }, undefined);
  },
  "mcp.providers.snapshot": async ({ params, respond, context }) => {
    if (!validateMcpProvidersSnapshotParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.providers.snapshot params: ${formatValidationErrors(validateMcpProvidersSnapshotParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before reading MCP providers"),
      );
      return;
    }
    const providersConfig = readMcpHubConfig(snapshot.config).providers;
    const toolDefinitions = listToolDefinitions(context);
    respond(
      true,
      {
        ok: true,
        hash: resolveConfigSnapshotHash(snapshot) || "",
        providers: buildMcpSnapshotRows({ providersConfig, toolDefinitions }),
      },
      undefined,
    );
  },
  "mcp.providers.apply": async ({ params, respond, context }) => {
    if (!validateMcpProvidersApplyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.providers.apply params: ${formatValidationErrors(validateMcpProvidersApplyParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before applying MCP providers"),
      );
      return;
    }
    const hashCheck = requireConfigBaseHash(params, snapshot);
    if (!hashCheck.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, hashCheck.error));
      return;
    }

    const inputProviders = Array.isArray(params.providers) ? params.providers : [];
    const currentProviders = readMcpHubConfig(snapshot.config).providers;
    const nextProviders = { ...currentProviders };
    const fieldErrors: McpFieldError[] = [];

    for (const rawProvider of inputProviders) {
      const providerId = normalizeMcpProviderId(String(rawProvider.providerId || ""));
      if (!providerId) {
        fieldErrors.push({
          providerId: "",
          field: "providerId",
          message: "providerId is required",
        });
        continue;
      }

      const preset =
        findMcpPresetByPresetId(String(rawProvider.presetId || "")) ||
        findMcpPresetByProviderId(providerId);
      if (!preset) {
        fieldErrors.push({
          providerId,
          field: "presetId",
          message: "unsupported MCP preset",
        });
        continue;
      }

      const configured = rawProvider.configured !== false;
      const previous = currentProviders[providerId];

      if (!configured) {
        if (previous?.secretRefs) {
          for (const secretRef of Object.values(previous.secretRefs)) {
            deleteSecret(secretRef);
          }
        }
        delete nextProviders[providerId];
        continue;
      }

      const nextEntry = {
        presetId: preset.presetId,
        enabled: rawProvider.enabled !== false,
        label: String(rawProvider.label || "").trim() || preset.label,
        region: String(rawProvider.region || "").trim(),
        workspace: String(rawProvider.workspace || "").trim(),
        scopes: Array.isArray(rawProvider.scopes)
          ? rawProvider.scopes.map((scope) => String(scope || "").trim()).filter(Boolean)
          : [],
        fields: {} as Record<string, string | number | boolean | null>,
        secretRefs: { ...(previous?.secretRefs || {}) } as Record<string, string>,
        updatedAt: new Date().toISOString(),
      };

      if (rawProvider.fields && typeof rawProvider.fields === "object" && !Array.isArray(rawProvider.fields)) {
        for (const [fieldKey, value] of Object.entries(rawProvider.fields as Record<string, unknown>)) {
          const normalizedField = String(fieldKey || "").trim();
          if (!normalizedField) continue;
          if (
            value === null ||
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            nextEntry.fields[normalizedField] = value as string | number | boolean | null;
          }
        }
      }

      if (
        rawProvider.secretValues &&
        typeof rawProvider.secretValues === "object" &&
        !Array.isArray(rawProvider.secretValues)
      ) {
        for (const [fieldKeyRaw, secretValueRaw] of Object.entries(
          rawProvider.secretValues as Record<string, unknown>,
        )) {
          const fieldKey = String(fieldKeyRaw || "").trim();
          if (!fieldKey) continue;
          const currentSecretRef = nextEntry.secretRefs[fieldKey];
          if (secretValueRaw === null || String(secretValueRaw || "").trim() === "") {
            if (currentSecretRef) {
              deleteSecret(currentSecretRef);
              delete nextEntry.secretRefs[fieldKey];
            }
            continue;
          }
          const secretValue = String(secretValueRaw);
          const nextSecretRef = buildMcpSecretRef(providerId, fieldKey);
          const writeResult = setSecret(nextSecretRef, secretValue);
          if (!writeResult.ok) {
            fieldErrors.push({
              providerId,
              field: fieldKey,
              message: writeResult.error || "failed to write secret",
            });
            continue;
          }
          nextEntry.secretRefs[fieldKey] = nextSecretRef;
        }
      }

      if (nextEntry.scopes.length === 0) {
        delete (nextEntry as { scopes?: string[] }).scopes;
      }
      if (Object.keys(nextEntry.fields).length === 0) {
        delete (nextEntry as { fields?: Record<string, unknown> }).fields;
      }
      if (Object.keys(nextEntry.secretRefs).length === 0) {
        delete (nextEntry as { secretRefs?: Record<string, string> }).secretRefs;
      }
      if (!nextEntry.region) {
        delete (nextEntry as { region?: string }).region;
      }
      if (!nextEntry.workspace) {
        delete (nextEntry as { workspace?: string }).workspace;
      }

      nextProviders[providerId] = nextEntry;
    }

    if (fieldErrors.length > 0) {
      respond(
        false,
        { ok: false, fieldErrors },
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid MCP provider payload", {
          details: { fieldErrors },
        }),
      );
      return;
    }

    const nextConfig = writeMcpHubConfig(snapshot.config, nextProviders);
    await writeConfigFile(nextConfig);
    const restart = scheduleGatewaySigusr1Restart({
      delayMs: 1200,
      reason: "mcp.providers.apply",
    });
    const nextSnapshot = await readConfigFileSnapshot();
    const providersConfig = nextSnapshot.valid
      ? readMcpHubConfig(nextSnapshot.config).providers
      : nextProviders;
    const toolDefinitions = listToolDefinitions(context);

    respond(
      true,
      {
        ok: true,
        restartRequired: true,
        restart,
        hash: nextSnapshot.valid ? resolveConfigSnapshotHash(nextSnapshot) || "" : "",
        providers: buildMcpSnapshotRows({ providersConfig, toolDefinitions }),
      },
      undefined,
    );
  },
};

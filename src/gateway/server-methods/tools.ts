import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { readMcpHubConfig, normalizeMcpProviderId } from "../../mcp/config.js";
import { validateToolsListParams, ErrorCodes, errorShape } from "../protocol/index.js";

type ToolProviderKind = "companion" | "mcp" | "builtin";

type ToolDefinition = {
  name: string;
  providerId: string;
  providerKind: ToolProviderKind;
  providerLabel: string;
  description: string;
  inputSchema: Record<string, unknown>;
  command: string;
  nodeId: string;
  nodeName: string;
};

type NodeAction = {
  id: string;
  label?: string;
  description?: string;
  command: string;
  params?: unknown;
};

type ConnectedNode = {
  nodeId: string;
  displayName?: string;
  actions?: NodeAction[];
};

type ToolsContext = {
  nodeRegistry: {
    listConnected: () => ConnectedNode[];
  };
};

const resolveProviderMeta = (params: {
  action: NodeAction;
  node: ConnectedNode;
}): { providerId: string; providerKind: ToolProviderKind; providerLabel: string } => {
  const actionParams =
    params.action.params && typeof params.action.params === "object" && !Array.isArray(params.action.params)
      ? (params.action.params as Record<string, unknown>)
      : {};

  const providerIdFromParams = String(
    actionParams.providerId ??
      actionParams.provider_id ??
      actionParams.mcpProviderId ??
      actionParams.mcp_provider_id ??
      "",
  ).trim();
  const providerLabelFromParams = String(
    actionParams.providerLabel ?? actionParams.provider_label ?? "",
  ).trim();
  const providerKindFromParams = String(
    actionParams.providerKind ?? actionParams.provider_kind ?? "",
  ).trim().toLowerCase();

  let providerId = providerIdFromParams;
  if (!providerId) {
    const command = String(params.action.command || "").trim();
    const actionId = String(params.action.id || "").trim();
    const candidate = command || actionId;
    if (candidate.toLowerCase().startsWith("mcp:")) {
      const idx = candidate.indexOf(".");
      providerId = idx > 0 ? candidate.slice(0, idx) : candidate;
    }
  }
  if (!providerId) {
    providerId = `companion:${params.node.nodeId}`;
  }

  let providerKind: ToolProviderKind;
  if (providerKindFromParams === "mcp" || providerKindFromParams === "builtin") {
    providerKind = providerKindFromParams;
  } else if (providerId.startsWith("mcp:")) {
    providerKind = "mcp";
  } else if (providerId.startsWith("builtin:")) {
    providerKind = "builtin";
  } else {
    providerKind = "companion";
  }

  const providerLabel =
    providerLabelFromParams ||
    (providerKind === "companion" ? params.node.displayName || params.node.nodeId : providerId);

  return {
    providerId: providerKind === "mcp" ? normalizeMcpProviderId(providerId) : providerId,
    providerKind,
    providerLabel,
  };
};

export const listTools = (context: ToolsContext) => {
  return context.nodeRegistry
    .listConnected()
    .flatMap((node) =>
      (node.actions ?? []).map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description,
        command: action.command,
        params: (action.params as Record<string, unknown> | undefined) ?? undefined,
        nodeId: node.nodeId,
        nodeName: node.displayName || node.nodeId,
      })),
    );
};

const COMMAND_HINTS: Record<string, string> = {
  "screen.snap":
    "Capture a screenshot. Use target/region to control capture area. Returns file metadata.",
  "screen.locate":
    "Locate candidate windows by query or template hint. Returns matched window metadata.",
  "window.focus":
    "Bring a target window to foreground by titleContains/processName.",
  "input.mouse.move":
    "Move pointer to coordinates. Supports space=pixel|percent.",
  "input.mouse.click":
    "Click mouse button with optional x/y/space and clicks count.",
  "input.scroll":
    "Scroll mouse wheel by delta at current or specified pointer position.",
  "input.key":
    "Type text into currently focused control.",
  "input.keyboard.type":
    "Type text into currently focused control.",
  "input.keypress":
    "Send key combos/special keys (e.g. ctrl+l, enter).",
};

function inferSchemaType(value: unknown): "string" | "number" | "boolean" | "array" | "object" {
  if (Array.isArray(value)) return "array";
  if (value === null) return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
}

function toInputSchema(params: unknown) {
  const properties: Record<string, Record<string, unknown>> = {};
  if (params && typeof params === "object" && !Array.isArray(params)) {
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      properties[key] = {
        type: inferSchemaType(value),
        ...(value !== undefined ? { default: value } : {}),
      };
    }
  }
  return {
    type: "object",
    properties,
    additionalProperties: true,
  };
}

export function listToolDefinitions(
  context: Parameters<typeof listTools>[0],
): ToolDefinition[] {
  return listTools(context).map((tool) => {
    const providerMeta = resolveProviderMeta({
      action: {
        id: tool.id,
        label: tool.label,
        description: tool.description,
        command: tool.command,
        params: tool.params,
      },
      node: {
        nodeId: tool.nodeId,
        displayName: tool.nodeName,
      },
    });
    const providerId = providerMeta.providerId;
    const name = `${providerId}.${tool.command}`;
    const description =
      tool.description?.trim() || COMMAND_HINTS[tool.command] || `Invoke companion command: ${tool.command}`;
    return {
      name,
      providerId,
      providerKind: providerMeta.providerKind,
      providerLabel: providerMeta.providerLabel,
      description,
      inputSchema: toInputSchema(tool.params),
      command: tool.command,
      nodeId: tool.nodeId,
      nodeName: tool.nodeName,
    };
  });
}

export function filterToolDefinitionsByMcpConfig(
  definitions: ToolDefinition[],
  providersConfig: ReturnType<typeof readMcpHubConfig>["providers"],
): ToolDefinition[] {
  return definitions.filter((definition) => {
    if (definition.providerKind !== "mcp") {
      return true;
    }
    const providerId = normalizeMcpProviderId(definition.providerId);
    const config = providersConfig[providerId];
    if (!config) {
      return false;
    }
    return config.enabled === true;
  });
}

export const toolsHandlers: GatewayRequestHandlers = {
  "tools.list": ({ params, respond, context }) => {
    if (!validateToolsListParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid tools.list params"));
      return;
    }
    const config = loadConfig();
    const providersConfig = readMcpHubConfig(config).providers;
    const definitions = filterToolDefinitionsByMcpConfig(listToolDefinitions(context), providersConfig);
    respond(true, { ok: true, definitions }, undefined);
  },
};

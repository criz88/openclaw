import type { GatewayRequestHandlers } from "./types.js";
import { validateToolsListParams, ErrorCodes, errorShape } from "../protocol/index.js";

export const listTools = (context: { nodeRegistry: { listConnected: () => Array<{ nodeId: string; displayName?: string; actions?: Array<{ id: string; label?: string; description?: string; command: string; params?: unknown }> }> } }) => {
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
): Array<{
  name: string;
  providerId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  command: string;
  nodeId: string;
  nodeName: string;
}> {
  return listTools(context).map((tool) => {
    const providerId = `companion:${tool.nodeId}`;
    const name = `${providerId}.${tool.command}`;
    const description =
      tool.description?.trim() || COMMAND_HINTS[tool.command] || `Invoke companion command: ${tool.command}`;
    return {
      name,
      providerId,
      description,
      inputSchema: toInputSchema(tool.params),
      command: tool.command,
      nodeId: tool.nodeId,
      nodeName: tool.nodeName,
    };
  });
}

export const toolsHandlers: GatewayRequestHandlers = {
  "tools.list": ({ params, respond, context }) => {
    if (!validateToolsListParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid tools.list params"));
      return;
    }
    const definitions = listToolDefinitions(context);
    respond(true, { ok: true, definitions }, undefined);
  },
};

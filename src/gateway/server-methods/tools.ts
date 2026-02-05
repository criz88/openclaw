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

export const TOOLS_POLICY_PROMPT =
  "When describing available tools or actions, ONLY use the tools.list data below. Do not list any internal/system tools.";

export function buildToolsPrompt(tools: ReturnType<typeof listTools>): string {
  if (tools.length === 0) return "";
  return [
    "Available actions (tools.list):",
    ...tools.map((tool) => {
      const label = tool.label || tool.id;
      const desc = tool.description ? ` — ${tool.description}` : "";
      const node = tool.nodeName ? ` @ ${tool.nodeName}` : "";
      return `- ${label}${node} (command: ${tool.command})${desc}`;
    }),
    "Use node.invoke with the command + params shown above to call these actions.",
  ].join("\n");
}

export const toolsHandlers: GatewayRequestHandlers = {
  "tools.list": ({ params, respond, context }) => {
    if (!validateToolsListParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid tools.list params"));
      return;
    }
    const tools = listTools(context);
    respond(true, { ok: true, tools }, undefined);
  },
};

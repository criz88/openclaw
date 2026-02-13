export type McpPresetFieldOption = {
  value: string;
  label: string;
};

export type McpPresetField = {
  key: string;
  label: string;
  description?: string;
  type: "text" | "password" | "url" | "number" | "boolean" | "select";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  options?: McpPresetFieldOption[];
  defaultValue?: string | number | boolean;
};

export type McpPreset = {
  presetId: string;
  providerId: string;
  label: string;
  description: string;
  iconKey: string;
  website?: string;
  docsUrl?: string;
  aliases?: string[];
  fields: McpPresetField[];
};

const MCP_PRESETS: McpPreset[] = [
  {
    presetId: "github",
    providerId: "mcp:github",
    label: "GitHub",
    description: "Repository, issue, and pull-request workflows",
    iconKey: "github",
    website: "https://github.com",
    docsUrl: "https://docs.github.com",
    aliases: ["github", "gh"],
    fields: [
      {
        key: "token",
        label: "Access Token",
        type: "password",
        required: true,
        secret: true,
        placeholder: "ghp_xxx",
      },
      {
        key: "apiBaseUrl",
        label: "API Base URL",
        type: "url",
        placeholder: "https://api.github.com",
        defaultValue: "https://api.github.com",
      },
    ],
  },
  {
    presetId: "figma",
    providerId: "mcp:figma",
    label: "Figma",
    description: "Design file and component operations",
    iconKey: "figma",
    website: "https://www.figma.com",
    docsUrl: "https://www.figma.com/developers",
    aliases: ["figma"],
    fields: [
      {
        key: "token",
        label: "Personal Access Token",
        type: "password",
        required: true,
        secret: true,
        placeholder: "figd_xxx",
      },
      {
        key: "teamId",
        label: "Team ID",
        type: "text",
        placeholder: "optional",
      },
    ],
  },
  {
    presetId: "notion",
    providerId: "mcp:notion",
    label: "Notion",
    description: "Page and database knowledge operations",
    iconKey: "notion",
    website: "https://www.notion.so",
    docsUrl: "https://developers.notion.com",
    aliases: ["notion"],
    fields: [
      {
        key: "token",
        label: "Integration Token",
        type: "password",
        required: true,
        secret: true,
        placeholder: "secret_xxx",
      },
      {
        key: "workspace",
        label: "Workspace",
        type: "text",
        placeholder: "optional",
      },
    ],
  },
  {
    presetId: "slack",
    providerId: "mcp:slack",
    label: "Slack",
    description: "Workspace messaging and channel workflows",
    iconKey: "slack",
    website: "https://slack.com",
    docsUrl: "https://api.slack.com",
    aliases: ["slack"],
    fields: [
      {
        key: "botToken",
        label: "Bot Token",
        type: "password",
        required: true,
        secret: true,
        placeholder: "xoxb-***",
      },
      {
        key: "appToken",
        label: "App Token",
        type: "password",
        secret: true,
        placeholder: "xapp-***",
      },
    ],
  },
  {
    presetId: "linear",
    providerId: "mcp:linear",
    label: "Linear",
    description: "Issue and project planning workflows",
    iconKey: "linear",
    website: "https://linear.app",
    docsUrl: "https://developers.linear.app",
    aliases: ["linear"],
    fields: [
      {
        key: "token",
        label: "API Key",
        type: "password",
        required: true,
        secret: true,
        placeholder: "lin_api_xxx",
      },
    ],
  },
  {
    presetId: "google-drive",
    providerId: "mcp:google-drive",
    label: "Google Drive",
    description: "Drive file and document operations",
    iconKey: "google-drive",
    website: "https://drive.google.com",
    docsUrl: "https://developers.google.com/drive",
    aliases: ["google-drive", "gdrive", "google"],
    fields: [
      {
        key: "credentialsJson",
        label: "Credentials JSON",
        type: "password",
        required: true,
        secret: true,
        placeholder: "{\"client_id\":\"...\"}",
      },
      {
        key: "sharedDriveId",
        label: "Shared Drive ID",
        type: "text",
        placeholder: "optional",
      },
    ],
  },
  {
    presetId: "postgres",
    providerId: "mcp:postgres",
    label: "Postgres",
    description: "Database query and schema operations",
    iconKey: "postgres",
    website: "https://www.postgresql.org",
    docsUrl: "https://www.postgresql.org/docs/",
    aliases: ["postgres", "postgresql"],
    fields: [
      {
        key: "connectionString",
        label: "Connection String",
        type: "password",
        required: true,
        secret: true,
        placeholder: "postgres://user:pass@host:5432/db",
      },
      {
        key: "sslMode",
        label: "SSL Mode",
        type: "select",
        options: [
          { value: "disable", label: "Disable" },
          { value: "prefer", label: "Prefer" },
          { value: "require", label: "Require" },
        ],
        defaultValue: "prefer",
      },
    ],
  },
];

export function listMcpPresets(): McpPreset[] {
  return MCP_PRESETS.map((preset) => ({
    ...preset,
    fields: preset.fields.map((field) => ({
      ...field,
      ...(Array.isArray(field.options) ? { options: field.options.map((option) => ({ ...option })) } : {}),
    })),
    ...(Array.isArray(preset.aliases) ? { aliases: [...preset.aliases] } : {}),
  }));
}

export function findMcpPresetByProviderId(providerId: string): McpPreset | undefined {
  const normalized = String(providerId || "").trim().toLowerCase();
  if (!normalized) return undefined;
  return MCP_PRESETS.find((preset) => preset.providerId.toLowerCase() === normalized);
}

export function findMcpPresetByPresetId(presetId: string): McpPreset | undefined {
  const normalized = String(presetId || "").trim().toLowerCase();
  if (!normalized) return undefined;
  return MCP_PRESETS.find((preset) => preset.presetId.toLowerCase() === normalized);
}

export function listMcpPresetProviderIds(): string[] {
  return MCP_PRESETS.map((preset) => preset.providerId);
}

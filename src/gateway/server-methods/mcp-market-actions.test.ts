import { beforeEach, describe, expect, it, vi } from "vitest";

const secrets = new Map<string, string>();

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(() => ({ ok: true })),
}));

vi.mock("./tools.js", () => ({
  listToolDefinitions: vi.fn(() => []),
}));

let configState: any = {};

vi.mock("../../config/config.js", async () => {
  const actual = await vi.importActual<any>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: vi.fn(async () => ({
      exists: true,
      valid: true,
      config: configState,
    })),
    resolveConfigSnapshotHash: vi.fn(() => "hash1"),
    writeConfigFile: vi.fn(async (next: any) => {
      configState = next;
    }),
  };
});

vi.mock("../../mcp/secret-store.js", () => ({
  setSecret: vi.fn((ref: string, value: string) => {
    secrets.set(ref, value);
    return { ok: true };
  }),
  getSecret: vi.fn((ref: string) => secrets.get(ref) ?? null),
  deleteSecret: vi.fn((ref: string) => {
    secrets.delete(ref);
    return { ok: true };
  }),
  hasSecret: vi.fn((ref: string) => secrets.has(ref)),
}));

describe("mcp.market.install/uninstall/refresh", () => {
  beforeEach(() => {
    secrets.clear();
    configState = {
      plugins: {
        entries: {
          "mcp-hub": {
            enabled: true,
            config: {
              version: 3,
              providers: {},
              marketConfig: {},
            },
          },
        },
      },
    };
  });

  it("installs provider from registry detail", async () => {
    const { fetchWithSsrFGuard } = await import("../../infra/net/fetch-guard.js");
    (fetchWithSsrFGuard as any).mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          qualifiedName: "exa",
          displayName: "Exa Search",
          description: "Fast search",
          iconUrl: "https://example.com/exa.svg",
          deploymentUrl: "https://exa.run.tools",
          connections: [{ type: "http", deploymentUrl: "https://exa.run.tools" }],
          tools: [
            { name: "web_search_exa", description: "search", inputSchema: { type: "object" } },
          ],
        }),
      },
      finalUrl: "https://registry.smithery.ai/servers/exa",
      release: async () => {},
    });

    const { mcpHandlers } = await import("./mcp.js");
    const respond = vi.fn();

    await (mcpHandlers["mcp.market.install"] as any)({
      params: {
        baseHash: "hash1",
        qualifiedName: "exa",
        providerId: "mcp:exa",
        label: "Exa",
        enabled: true,
        fields: { deploymentUrl: "https://exa.run.tools" },
        secretValues: { token: "t" },
      },
      respond,
      context: {},
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        providers: expect.arrayContaining([
          expect.objectContaining({
            providerId: "mcp:exa",
            source: "market",
            qualifiedName: "exa",
          }),
        ]),
        marketConfig: expect.objectContaining({
          registryBaseUrl: expect.any(String),
        }),
      }),
      undefined,
    );
  });

  it("refresh stores smithery api key in secret store", async () => {
    const { mcpHandlers } = await import("./mcp.js");
    const respond = vi.fn();

    await (mcpHandlers["mcp.market.refresh"] as any)({
      params: {
        baseHash: "hash1",
        registryBaseUrl: "https://registry.smithery.ai",
        smitheryApiKey: "k",
      },
      respond,
      context: {},
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        marketConfig: expect.objectContaining({
          apiKeyConfigured: true,
        }),
      }),
      undefined,
    );
  });

  it("uninstall removes provider entry", async () => {
    configState.plugins.entries["mcp-hub"].config.providers = {
      "mcp:exa": {
        enabled: true,
        source: "catalog",
        qualifiedName: "exa",
        label: "Exa",
        connection: { type: "http", deploymentUrl: "https://exa.run.tools", authType: "bearer" },
      },
    };

    const { mcpHandlers } = await import("./mcp.js");
    const respond = vi.fn();

    await (mcpHandlers["mcp.market.uninstall"] as any)({
      params: {
        baseHash: "hash1",
        providerId: "mcp:exa",
      },
      respond,
      context: {},
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        providers: expect.not.arrayContaining([
          expect.objectContaining({
            providerId: "mcp:exa",
          }),
        ]),
      }),
      undefined,
    );
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

describe("mcp.market.search", () => {
  it("maps registry servers response into desktop market items", async () => {
    const { fetchWithSsrFGuard } = await import("../../infra/net/fetch-guard.js");
    (fetchWithSsrFGuard as any).mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          servers: [
            {
              qualifiedName: "exa",
              displayName: "Exa Search",
              description: "Fast, intelligent web search",
              iconUrl: "https://example.com/exa.svg",
            },
          ],
          pagination: { currentPage: 1, pageSize: 20, totalPages: 1, totalCount: 1 },
        }),
      },
      finalUrl: "https://registry.smithery.ai/servers?q=exa&page=1&pageSize=20",
      release: async () => {},
    });

    const { mcpHandlers } = await import("./mcp.js");
    const respond = vi.fn();

    await (mcpHandlers["mcp.market.search"] as any)({
      params: { query: "exa", page: 1, pageSize: 20 },
      respond,
    });

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/servers?q=exa"),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        registryBaseUrl: expect.any(String),
        items: [
          expect.objectContaining({
            qualifiedName: "exa",
            displayName: "Exa Search",
          }),
        ],
        pagination: expect.objectContaining({
          currentPage: 1,
          pageSize: 20,
          totalPages: 1,
          totalCount: 1,
        }),
      }),
      undefined,
    );
  });
});

describe("mcp.market.detail", () => {
  it("returns detail with connections", async () => {
    const { fetchWithSsrFGuard } = await import("../../infra/net/fetch-guard.js");
    (fetchWithSsrFGuard as any).mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          qualifiedName: "exa",
          displayName: "Exa Search",
          deploymentUrl: "https://exa.run.tools",
          connections: [
            { type: "http", deploymentUrl: "https://exa.run.tools", authType: "bearer" },
          ],
        }),
      },
      finalUrl: "https://registry.smithery.ai/servers/exa",
      release: async () => {},
    });

    const { mcpHandlers } = await import("./mcp.js");
    const respond = vi.fn();

    await (mcpHandlers["mcp.market.detail"] as any)({
      params: { qualifiedName: "exa" },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        detail: expect.objectContaining({
          qualifiedName: "exa",
          connections: [
            expect.objectContaining({ type: "http", deploymentUrl: "https://exa.run.tools" }),
          ],
        }),
      }),
      undefined,
    );
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    valid: true,
    config: {
      plugins: {
        entries: {
          "mcp-hub": {
            config: {
              builtinProviders: {
                "mcp:figma": {
                  presetId: "figma",
                  label: "Figma",
                  description: "Design file and component operations",
                  website: "https://www.figma.com",
                  docsUrl: "https://www.figma.com/developers",
                  implementationSource: "official",
                  requiredSecrets: ["token"],
                  statusHints: ["Token required"],
                },
              },
            },
          },
        },
      },
    },
  })),
}));

describe("mcp.presets.list", () => {
  it("returns presets derived from builtinProviders with secret fields from requiredSecrets", async () => {
    const { mcpHandlers } = await import("./mcp.js");
    const respond = vi.fn();

    await (mcpHandlers["mcp.presets.list"] as any)({ respond });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        presets: [
          expect.objectContaining({
            presetId: "figma",
            providerId: "mcp:figma",
            label: "Figma",
            requiredSecrets: ["token"],
            fields: [
              expect.objectContaining({
                key: "token",
                secret: true,
                required: true,
              }),
            ],
          }),
        ],
      }),
      undefined,
    );
  });
});

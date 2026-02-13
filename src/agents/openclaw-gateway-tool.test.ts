import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async (method: string) => {
    if (method === "config.get") {
      return { hash: "hash-1" };
    }
    return { ok: true };
  }),
}));

describe("gateway tool", () => {
  it("schedules SIGUSR1 restart", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousProfile = process.env.OPENCLAW_PROFILE;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_PROFILE = "isolated";

    try {
      const tool = createOpenClawTools({
        config: { commands: { restart: true } },
      }).find((candidate) => candidate.name === "gateway");
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error("missing gateway tool");
      }

      const result = await tool.execute("call1", {
        action: "restart",
        delayMs: 0,
      });
      expect(result.details).toMatchObject({
        ok: true,
        pid: process.pid,
        signal: "SIGUSR1",
        delayMs: 0,
      });

      const sentinelPath = path.join(stateDir, "restart-sentinel.json");
      const raw = await fs.readFile(sentinelPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        payload?: { kind?: string; doctorHint?: string | null };
      };
      expect(parsed.payload?.kind).toBe("restart");
      expect(parsed.payload?.doctorHint).toBe(
        "Run: openclaw --profile isolated doctor --non-interactive",
      );

      expect(kill).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGUSR1");
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousProfile === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = previousProfile;
      }
    }
  });

  it("passes config.apply through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:whatsapp:dm:+15555550123",
    }).find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    const raw = '{\n  agents: { defaults: { workspace: "~/openclaw" } }\n}\n';
    await tool.execute("call2", {
      action: "config.apply",
      raw,
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.objectContaining({
        raw: raw.trim(),
        baseHash: "hash-1",
        sessionKey: "agent:main:whatsapp:dm:+15555550123",
      }),
    );
  });

  it("passes config.patch through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:whatsapp:dm:+15555550123",
    }).find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    const raw = '{\n  channels: { telegram: { groups: { "*": { requireMention: false } } } }\n}\n';
    await tool.execute("call4", {
      action: "config.patch",
      raw,
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.objectContaining({
        raw: raw.trim(),
        baseHash: "hash-1",
        sessionKey: "agent:main:whatsapp:dm:+15555550123",
      }),
    );
  });

  it("passes update.run through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:whatsapp:dm:+15555550123",
    }).find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing gateway tool");
    }

    await tool.execute("call3", {
      action: "update.run",
      note: "test update",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "update.run",
      expect.any(Object),
      expect.objectContaining({
        note: "test update",
        sessionKey: "agent:main:whatsapp:dm:+15555550123",
      }),
    );
    const updateCall = vi
      .mocked(callGatewayTool)
      .mock.calls.find((call) => call[0] === "update.run");
    expect(updateCall).toBeDefined();
    if (updateCall) {
      const [, opts, params] = updateCall;
      expect(opts).toMatchObject({ timeoutMs: 20 * 60_000 });
      expect(params).toMatchObject({ timeoutMs: 20 * 60_000 });
    }
  });

  it("passes mcp.providers.apply through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = createOpenClawTools().find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing gateway tool");

    const providers = [
      {
        providerId: "mcp:figma",
        presetId: "figma",
        configured: true,
        enabled: true,
        fields: { teamId: "team_1" },
      },
    ];
    await tool.execute("call-mcp-apply", {
      action: "mcp.providers.apply",
      baseHash: "hash-1",
      providers,
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "mcp.providers.apply",
      expect.any(Object),
      expect.objectContaining({
        baseHash: "hash-1",
        providers,
      }),
    );
  });

  it("supports tools.list with providerKind filter", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "tools.list") {
        return {
          ok: true,
          definitions: [
            { name: "mcp:figma.projects.list", providerId: "mcp:figma", providerKind: "mcp" },
            { name: "companion:abc.screen.snap", providerId: "companion:abc", providerKind: "companion" },
          ],
        };
      }
      return { ok: true };
    });
    const tool = createOpenClawTools().find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing gateway tool");

    const result = await tool.execute("call-tools-list", {
      action: "tools.list",
      providerKind: "mcp",
    });
    const details = result.details as { ok: boolean; count: number; definitions: Array<{ name: string }> };
    expect(details.ok).toBe(true);
    expect(details.count).toBe(1);
    expect(details.definitions[0]?.name).toBe("mcp:figma.projects.list");
  });

  it("supports tools.call via gateway tools.call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockImplementation(async (method: string, _opts: unknown, params: unknown) => {
      if (method === "tools.call") {
        return {
          ok: true,
          providerId: "mcp:figma",
          toolName: "mcp:figma.projects.list",
          command: "projects.list",
          result: { items: [{ id: "p1" }] },
          params,
        };
      }
      return { ok: true };
    });
    const tool = createOpenClawTools().find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing gateway tool");

    const result = await tool.execute("call-tools-call", {
      action: "tools.call",
      providerId: "mcp:figma",
      toolName: "projects.list",
      toolArgs: { teamId: "t1" },
    });
    const details = result.details as {
      ok: boolean;
      providerId: string;
      toolName: string;
      result: { ok: boolean; command: string; result: { items: Array<{ id: string }> } };
    };
    expect(details.ok).toBe(true);
    expect(details.providerId).toBe("mcp:figma");
    expect(details.toolName).toBe("projects.list");
    expect(details.result.ok).toBe(true);
    expect(details.result.command).toBe("projects.list");
    expect(details.result.result.items[0]?.id).toBe("p1");

    expect(callGatewayTool).toHaveBeenCalledWith(
      "tools.call",
      expect.any(Object),
      expect.objectContaining({
        providerId: "mcp:figma",
        toolName: "projects.list",
        params: { teamId: "t1" },
      }),
    );
  });

  it("supports mcp.market.search via gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "mcp.market.search") {
        return {
          ok: true,
          items: [{ qualifiedName: "smithery-ai/github", displayName: "GitHub" }],
          pagination: { currentPage: 1, pageSize: 20, totalPages: 1, totalCount: 1 },
        };
      }
      return { ok: true };
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing gateway tool");

    const result = await tool.execute("call-mcp-market-search", {
      action: "mcp.market.search",
      query: "github",
      page: 1,
      pageSize: 20,
    });
    expect((result.details as { ok: boolean }).ok).toBe(true);
    expect(callGatewayTool).toHaveBeenCalledWith(
      "mcp.market.search",
      expect.any(Object),
      expect.objectContaining({
        query: "github",
        page: 1,
        pageSize: 20,
      }),
    );
  });

  it("supports mcp.market.install via gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = createOpenClawTools().find((candidate) => candidate.name === "gateway");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing gateway tool");

    await tool.execute("call-mcp-market-install", {
      action: "mcp.market.install",
      qualifiedName: "smithery-ai/github",
      providerId: "mcp:github-market",
      providerLabel: "GitHub (Market)",
      mcpFields: { deploymentUrl: "https://example.test/mcp" },
      mcpSecretValues: { token: "secret-token" },
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "mcp.market.install",
      expect.any(Object),
      expect.objectContaining({
        qualifiedName: "smithery-ai/github",
        providerId: "mcp:github-market",
        label: "GitHub (Market)",
        fields: { deploymentUrl: "https://example.test/mcp" },
        secretValues: { token: "secret-token" },
      }),
    );
  });
});

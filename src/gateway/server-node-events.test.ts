import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));
vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

import type { CliDeps } from "../cli/deps.js";
import type { HealthSummary } from "../commands/health.js";
import type { NodeEventContext } from "./server-node-events-types.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { handleNodeEvent } from "./server-node-events.js";

const enqueueSystemEventMock = vi.mocked(enqueueSystemEvent);
const requestHeartbeatNowMock = vi.mocked(requestHeartbeatNow);

function buildCtx(): NodeEventContext {
  return {
    deps: {} as CliDeps,
    broadcast: () => {},
    nodeSendToSession: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    broadcastVoiceWakeChanged: () => {},
    addChatRun: () => {},
    removeChatRun: () => undefined,
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as HealthSummary,
    loadGatewayModelCatalog: async () => [],
    logGateway: { warn: () => {} },
    nodeRegistry: {
      get: () => undefined,
      setActions: () => true,
    },
  };
}

describe("node exec events", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    requestHeartbeatNowMock.mockReset();
  });

  it("enqueues exec.started events", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(ctx, "node-1", {
      event: "exec.started",
      payloadJSON: JSON.stringify({
        sessionKey: "agent:main:main",
        runId: "run-1",
        command: "ls -la",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec started (node=node-1 id=run-1): ls -la",
      { sessionKey: "agent:main:main", contextKey: "exec:run-1" },
    );
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({ reason: "exec-event" });
  });

  it("enqueues exec.finished events with output", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON: JSON.stringify({
        runId: "run-2",
        exitCode: 0,
        timedOut: false,
        output: "done",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2 id=run-2, code 0)\ndone",
      { sessionKey: "desktop-node-2", contextKey: "exec:run-2" },
    );
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({ reason: "exec-event" });
  });

  it("rewrites desktop-node session key suffix to display name slug", async () => {
    const ctx = buildCtx();
    ctx.nodeRegistry.get = () => ({ displayName: "Alice Surface Pro" });
    await handleNodeEvent(ctx, "a1b2c3d4e5f678901234567890", {
      event: "exec.started",
      payloadJSON: JSON.stringify({
        sessionKey: "desktop-node-a1b2c3d4e5f678901234567890",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec started (node=a1b2c3d4e5f678901234567890)",
      { sessionKey: "desktop-node-alice-surface-pro", contextKey: "exec" },
    );
  });

  it("rewrites desktop session key suffix to display name slug", async () => {
    const ctx = buildCtx();
    ctx.nodeRegistry.get = () => ({ displayName: "Studio Workstation" });
    await handleNodeEvent(ctx, "9f8e7d6c5b4a321001122334455", {
      event: "exec.started",
      payloadJSON: JSON.stringify({
        sessionKey: "desktop-9f8e7d6c5b4a321001122334455",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec started (node=9f8e7d6c5b4a321001122334455)",
      { sessionKey: "desktop-studio-workstation", contextKey: "exec" },
    );
  });

  it("rewrites agent-scoped desktop session key suffix to display name slug", async () => {
    const ctx = buildCtx();
    ctx.nodeRegistry.get = () => ({ displayName: "OpenClaw Companion" });
    await handleNodeEvent(ctx, "24fc739ad7bc11223344556677889900", {
      event: "exec.started",
      payloadJSON: JSON.stringify({
        sessionKey: "agent:dev:desktop-24fc739ad7bc11223344556677889900",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec started (node=24fc739ad7bc11223344556677889900)",
      { sessionKey: "agent:dev:desktop-openclaw-companion", contextKey: "exec" },
    );
  });

  it("enqueues exec.denied events with reason", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(ctx, "node-3", {
      event: "exec.denied",
      payloadJSON: JSON.stringify({
        sessionKey: "agent:demo:main",
        runId: "run-3",
        command: "rm -rf /",
        reason: "allowlist-miss",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec denied (node=node-3 id=run-3, allowlist-miss): rm -rf /",
      { sessionKey: "agent:demo:main", contextKey: "exec:run-3" },
    );
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({ reason: "exec-event" });
  });
});

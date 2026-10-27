import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRemoteNode } from "../db/repositories/nodes.ts";
import {
  asProviderId,
  isProviderInterruptedError,
  type ProviderEvent,
  type ProviderRunInput
} from "../providers/types.ts";
import { NodeOfflineError } from "./hub.ts";
import { remoteProvidersForNode } from "./remoteProvider.ts";
import { useTestNodeHub, waitUntil as waitFor } from "./testing.ts";

const startNodeHub = useTestNodeHub();

async function connectNode(options: { offlineGraceMs?: number } = {}) {
  const fixture = await startNodeHub();
  const node = getRemoteNode(fixture.database, fixture.nodeId)!;
  return { ...fixture, remote: remoteProvidersForNode(fixture.hub, node, options).codex! };
}

function runInput(cwd: string, prompt: string, events: ProviderEvent[]): ProviderRunInput {
  return {
    cwd,
    images: [{ path: "/hub/only/image.png", type: "localImage" }],
    issueId: 7,
    onEvent: (event) => events.push(event),
    projectId: "proj",
    prompt,
    sandbox: "workspace-write"
  };
}

describe("remote executor provider", () => {
  test("mirrors the node's provider capabilities, policy manifest and status", async () => {
    const { remote } = await connectNode();
    expect(remote.id).toBe(asProviderId("codex"));
    // 会话类能力 v1 不经节点开放。
    expect(remote.capabilities).toEqual(["issue_execution", "interrupt", "approvals"]);
    expect(remote.interruptScope).toBe("turn");
    expect(remote.manifest?.id).toBe(asProviderId("codex"));
    expect(remote.policyAdapter).toBeDefined();
    expect(remote.runtimeStatus?.()).toMatchObject({ mode: "remote", ready: true, version: "0.99.0" });
  });

  test("runs on the node and streams provider events back in order", async () => {
    const { allowed, fake, remote } = await connectNode();
    const events: ProviderEvent[] = [];
    const result = await remote.run(runInput(join(allowed, "repo"), "do it", events));
    expect(result).toEqual({ runId: "run-on-node-7", session: { provider: "codex", sessionId: "thread-7", turnId: "turn-7" } });
    expect(events.map((event) => event.type)).toEqual(["turn.started", "agent.message"]);
    expect(events[1]?.text).toBe("hello from node");
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]!.cwd).toBe(await realpath(join(allowed, "repo")));
    // 中心本地图片路径不发往节点。
    expect(fake.received[0]!.images).toBeUndefined();
  });

  test("surfaces provider failures and refuses paths outside the node's roots", async () => {
    const { allowed, fake, remote } = await connectNode();
    await expect(remote.run(runInput(join(allowed, "repo"), "[[fail]]", []))).rejects.toThrow("model exploded");
    await expect(remote.run(runInput(tmpdir(), "do it", []))).rejects.toThrow("outside the node's allowed roots");
    expect(fake.received).toHaveLength(1);
  });

  test("forwards interrupts and approvals to the node", async () => {
    const { allowed, fake, remote } = await connectNode();
    const running = remote.run(runInput(join(allowed, "repo"), "[[wait]]", []));
    await waitFor(() => fake.received.length === 1);
    await remote.resolveApproval!("approval-1", { decision: "accept" });
    expect(fake.approvals).toEqual([["approval-1", { decision: "accept" }]]);
    await remote.interrupt!({ session: { provider: "codex", sessionId: "thread-7", turnId: "turn-7" } });
    const error = await running.catch((caught: unknown) => caught);
    expect(isProviderInterruptedError(error)).toBe(true);
  });

  test("a run survives a short node disconnect", async () => {
    const { allowed, fake, hub, nodeId, remote } = await connectNode({ offlineGraceMs: 2_500 });
    const events: ProviderEvent[] = [];
    const survivor = remote.run(runInput(join(allowed, "repo"), "[[wait]]", events));
    await waitFor(() => events.length === 2);
    // 模拟网络抖动：中心断开下行通道，同一个节点进程自行重连。
    hub.disconnect(nodeId);
    expect(hub.isOnline(nodeId)).toBe(false);
    await waitFor(() => hub.isOnline(nodeId), 3_000);
    // 重连后仍在等待节点结果，没有因短暂断线失败。
    const pending = await Promise.race([survivor.then(() => "settled", () => "settled"), Bun.sleep(10).then(() => "pending")]);
    expect(pending).toBe("pending");
    await remote.interrupt!({ session: { provider: "codex", sessionId: "thread-7" } });
    expect(isProviderInterruptedError(await survivor.catch((caught: unknown) => caught))).toBe(true);
    expect(fake.received).toHaveLength(1);
  });

  test("fails a run whose node stays offline past the grace period", async () => {
    const { agent, allowed, fake, hub, nodeId, remote } = await connectNode({ offlineGraceMs: 100 });
    const running = remote.run(runInput(join(allowed, "repo"), "[[wait]]", []));
    await waitFor(() => fake.received.length === 1);
    agent.stop();
    await waitFor(() => !hub.isOnline(nodeId));
    await expect(running).rejects.toBeInstanceOf(NodeOfflineError);
    expect(remote.runtimeStatus?.()).toMatchObject({ ready: false, reason: "node offline" });
  });
});

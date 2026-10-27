import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { NODE_SKILL_ROOT_TOKEN } from "./protocol.ts";
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
    expect(remote.capabilities).toEqual(["issue_execution", "interrupt", "approvals", "model_list", "resume_session"]);
    expect(remote.interruptScope).toBe("turn");
    expect(remote.manifest?.id).toBe(asProviderId("codex"));
    expect(remote.policyAdapter).toBeDefined();
    expect(remote.runtimeStatus?.()).toMatchObject({ mode: "remote", ready: true, version: "0.99.0" });
  });

  test("reads sessions and models on the node but never creates sessions there", async () => {
    const { remote } = await connectNode();
    expect(await remote.readSession!("thread-7")).toMatchObject({ provider_session_id: "thread-7", turns: [{ id: "turn-on-node", status: "completed" }] });
    expect(await remote.listModels!()).toEqual([{ display_name: "Node model", id: "node-model" }]);
    expect(remote.listSessions).toBeUndefined();
    expect(remote.createSession).toBeUndefined();
    expect(remote.sendSessionMessage).toBeUndefined();
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
  });

  test("keeps streaming events that arrive after run() returns until a terminal event", async () => {
    const { allowed, remote } = await connectNode();
    const events: ProviderEvent[] = [];
    await remote.run(runInput(join(allowed, "repo"), "[[late]]", events));
    await waitFor(() => events.some((event) => event.type === "turn.completed"));
    expect(events.map((event) => event.text ?? event.type)).toEqual(["turn.started", "hello from node", "late message", "turn.completed"]);
  });

  test("ships hub-local images and managed skill packages to the node", async () => {
    const { allowed, fake, remote } = await connectNode();
    const hubFiles = await mkdtemp(join(tmpdir(), "xuanwu-hub-files-"));
    const image = join(hubFiles, "screenshot.png");
    await writeFile(image, "png-bytes");
    const skill = join(hubFiles, "skill");
    await mkdir(join(skill, "refs"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Skill\n");
    await writeFile(join(skill, "refs", "guide.md"), "guide\n");
    const directory = `${"a".repeat(24)}/12345678-1234-1234-1234-123456789abc/demo-skill`;
    const input: ProviderRunInput = {
      ...runInput(join(allowed, "repo"), `Read ${NODE_SKILL_ROOT_TOKEN}/${directory}/SKILL.md`, []),
      images: [{ detail: "high", path: image, type: "localImage" }],
      skillPackages: [{ directory, path: skill }]
    };

    await remote.run(input);

    const received = fake.received[0]!;
    expect(received.skillPackages).toBeUndefined();
    const skillPath = /Read (\S+)\/SKILL\.md/.exec(received.prompt)![1]!;
    expect(skillPath).not.toContain(NODE_SKILL_ROOT_TOKEN);
    expect(await readFile(join(skillPath, "refs", "guide.md"), "utf8")).toBe("guide\n");
    expect(received.images).toHaveLength(1);
    expect(received.images![0]).toMatchObject({ detail: "high", type: "localImage" });
    expect(received.images![0]!.path).not.toBe(image);
    await rm(hubFiles, { force: true, recursive: true });
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

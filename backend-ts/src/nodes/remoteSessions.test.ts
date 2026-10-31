import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { adminFetch, useTestNodeHub, waitUntil } from "./testing.ts";

const startNodeHub = useTestNodeHub();

async function hubWithRemoteProject() {
  const fixture = await startNodeHub();
  const repo = await realpath(join(fixture.allowed, "repo"));
  await adminFetch(fixture.baseUrl, "/api/projects", {
    body: JSON.stringify({ cwd: repo, id: "remote-repo", node_id: fixture.nodeId, provider: "codex" }),
    method: "POST"
  });
  return { ...fixture, repo };
}

describe("interactive sessions on remote nodes", () => {
  test("the chat page creates, lists and continues a session on the project's node", async () => {
    const { baseUrl, fake, repo } = await hubWithRemoteProject();

    const created = await adminFetch(baseUrl, "/api/sessions", {
      body: JSON.stringify({ project_id: "remote-repo", prompt: "hi node", provider: "codex" }),
      method: "POST"
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: "codex:chat-1", provider: "codex" });
    // 节点收到的是它自己的路径，而不是中心内部的 node:// 形式。
    expect(fake.createdSessions[0]).toMatchObject({ cwd: repo, prompt: "hi node" });

    const listed = await (await adminFetch(baseUrl, "/api/sessions?project_id=remote-repo")).json() as { data: Array<{ id: string }> };
    expect(listed.data.map((item) => item.id)).toContain("codex:chat-1");

    const continued = await adminFetch(baseUrl, "/api/sessions/codex:chat-1/messages", {
      body: JSON.stringify({ prompt: "and then?" }),
      method: "POST"
    });
    expect(continued.status).toBe(201);
    expect(await continued.json()).toMatchObject({ thread_id: "chat-1", turn_id: "msg-turn-1" });
    expect(fake.sessionMessages[0]).toMatchObject({ prompt: "and then?", sessionId: "chat-1" });
  });

  test("approval requests from a node session reach the hub bus and are resolved on that node", async () => {
    const { agent, baseUrl, fake, published } = await hubWithRemoteProject();

    agent.emitAppEvent({
      method: "approval/requested",
      raw_payload: JSON.stringify({ id: "approval-on-node", method: "item/commandExecution/requestApproval", params: { command: "rm -rf build" } }),
      threadId: "chat-1",
      type: "codex.event"
    });
    await waitUntil(() => published.some((event) => (event as { method?: string }).method === "approval/requested"));

    const resolved = await adminFetch(baseUrl, "/api/codex/approvals/approval-on-node/resolve", {
      body: JSON.stringify({ decision: "accept" }),
      method: "POST"
    });
    expect(resolved.status).toBe(200);
    // 中心照常归一化审批决定后转给发起它的节点。
    expect(fake.approvals).toEqual([["approval-on-node", { decision: "approve", scope: "turn" }]]);
  });
});

import { expect, test } from "bun:test";
import { join } from "node:path";
import { getProject } from "../db/repositories/projects.ts";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { insertIssue } from "../testing/harness.ts";
import { runProjectLoopOnce } from "../runner/projectLoop.ts";
import { adminFetch, useTestNodeHub } from "./testing.ts";

const startNodeHub = useTestNodeHub();

test("a node-only preset saves as project default and is inherited by execution", async () => {
  const { baseUrl, database, nodeId, allowed, fake } = await startNodeHub();
  expect(await (await adminFetch(baseUrl, "/api/providers")).json()).toEqual([]);
  const created = await adminFetch(baseUrl, "/api/projects", {
    method: "POST", body: JSON.stringify({ id: "preset-project", cwd: join(allowed, "repo"), node_id: nodeId, provider: "codex" })
  });
  expect(created.status).toBe(201);
  const saved = await adminFetch(baseUrl, "/api/projects/preset-project", {
    method: "PATCH", body: JSON.stringify({ default_agent_profile_id: "xuanwu-provider-codex" })
  });
  expect(saved.status).toBe(200);
  expect(getProject(database, "preset-project")?.default_agent_profile_id).toBe("xuanwu-provider-codex");
  const inherited = await adminFetch(baseUrl, "/api/works", {
    method: "POST", body: JSON.stringify({
      project_id: "preset-project", agent_profile_id: "", status: "triage",
      title: "Follow project settings", goal: "Use the remote project default", type: "engineering_task",
      audit: { actor: { kind: "user", id: "test" }, event_id: "remote-default-preset",
        correlation_id: "preset-test", occurred_at: "2026-10-28T00:00:00Z", reason: "test inheritance" }
    })
  });
  expect(inherited.status).toBe(201);
  expect(await inherited.json()).toMatchObject({ work: {
    agent_profile_id: "", effective_provider: "codex",
    effective_agent_profile: { id: "xuanwu-provider-codex", source: "project_default" }
  } });
  const issueId = insertIssue(database, { project_id: "preset-project", status: "todo", title: "Use project preset" });
  await runProjectLoopOnce({ database, projectId: "preset-project", providers: {} });
  expect(fake.received).toHaveLength(1);
  expect(listIssueRuns(database, issueId)[0]).toMatchObject({ provider: "codex", agent_profile_id: "xuanwu-provider-codex" });
  const missing = await adminFetch(baseUrl, "/api/projects/preset-project", {
    method: "PATCH", body: JSON.stringify({ default_agent_profile_id: "missing" })
  });
  expect(missing.status).toBe(400);
  const cleared = await adminFetch(baseUrl, "/api/projects/preset-project", {
    method: "PATCH", body: JSON.stringify({ default_agent_profile_id: "" })
  });
  expect(cleared.status).toBe(200);
});

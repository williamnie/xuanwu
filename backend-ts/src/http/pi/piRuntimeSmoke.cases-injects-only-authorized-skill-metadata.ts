import { expect, test } from "bun:test";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { createPiDelegation, createPiMemoryItem, listPiActionEvents } from "../../db/repositories/pi.ts";
import { createPiRuntimeSession } from "./piRuntime.ts";
import { insertProject } from "../../testing/harness.ts";
import { configureFauxAgent } from "../../testing/fauxPi.ts";
import type { TestFixture } from "./piRuntimeSmoke.testFixture.ts";

export function registerInjectsOnlyAuthorizedSkillMetadataCases(testScope: TestFixture) {
  const { openFixtureDatabase, SMOKE_PROVIDER, EXECUTABLE, agentRecord, projectRecord } = testScope;
  test("injects only authorized skill metadata into PI runtime prompt and audits the summary", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo", { ...EXECUTABLE, default_skill_policy_json: JSON.stringify({
        allowed: ["xuanwu"],
        recommended: ["xuanwu", "verification-before-completion"]
      }) });
      const issue = createIssue(database, {
        project_id: "demo",
        recommended_skill_intents: ["verification-before-completion"],
        required_skill_intents: ["xuanwu"],
        title: "Skill scoped issue"
      });
      createPiDelegation(database, {
        allowed_skill_intents_json: ["xuanwu"],
        id: "delegation-a",
        project_id: "demo"
      });
      createPiMemoryItem(database, {
        confidence: "high",
        content: "Issue-specific PI context",
        id: "issue-memory",
        kind: "decision",
        scope: "issue",
        scope_id: String(issue.id),
        source_id: "turn-1",
        source_type: "conversation"
      });
      createPiMemoryItem(database, {
        content: "Disabled memory should stay hidden",
        disabled: 1,
        id: "disabled-memory",
        kind: "decision",
        scope: "issue",
        scope_id: String(issue.id)
      });
      configureFauxAgent(database, SMOKE_PROVIDER);
  
      const runtime = await createPiRuntimeSession(database, {
        agent: agentRecord(),
        authorization: {
          allowedSkillIntents: ["xuanwu", "verification-before-completion"],
          mode: "delegated"
        },
        conversationID: "conv-skill-context",
        promptProfile: "chat",
        delegationID: "delegation-a",
        issueID: issue.id,
        project: projectRecord("demo")
      });
      await runtime.session.reload();
      const prompt = runtime.session.systemPrompt;
      runtime.dispose();
  
      expect(prompt).toContain("Relevant Skill Metadata:");
      expect(prompt).toContain("Repo-aware issue proposal workflow:");
      expect(prompt).toContain("repo_search");
      expect(prompt).toContain("repo_context_pack");
      expect(prompt).toContain("issue_create_proposal");
      expect(prompt).toContain("最多追问一个关键问题");
      expect(prompt).toContain('"id": "xuanwu"');
      expect(prompt).not.toContain('"id": "verification-before-completion"');
      expect(prompt).toContain("Controlled Supervisor resource summary:");
      expect(prompt).toContain("<name>xuanwu</name>");
      expect(prompt).not.toContain("<name>pi-domain-proposal</name>");
      expect(prompt).toContain("Issue-specific PI context");
      expect(prompt).toContain("pi_memory_items/issue-memory");
      expect(prompt).not.toContain("Disabled memory should stay hidden");
      const events = listPiActionEvents(database, { conversationId: "conv-skill-context" });
      expect(events.map((event) => event.event_type)).toContain("skill_prompt_context_injected");
      expect(events.map((event) => event.event_type)).toContain("runtime_resource_snapshot");
      const audit = JSON.parse(events.find((event) => event.event_type === "skill_prompt_context_injected")?.payload_json ?? "{}");
      expect(audit).toMatchObject({
        injected_skill_ids: ["xuanwu"],
        scope: { delegation_id: "delegation-a", issue_id: issue.id, project_id: "demo" },
        unauthorized_skill_intents: ["verification-before-completion"]
      });
      expect(JSON.stringify(audit)).toContain("Create, enqueue, inspect");
      const resourceEvents = events.filter((event) => event.event_type === "runtime_resource_snapshot");
      const resources = JSON.parse(resourceEvents.at(-1)?.payload_json ?? "{}");
      expect(resources).toMatchObject({
        counts: { skills: 1 },
        generation: 2,
        loaded: { skills: ["xuanwu"] },
        outcome: "loaded"
      });
      expect(resourceEvents).toHaveLength(2);
    });
  
  test("injects agent-specific instructions into PI runtime system prompt after core constraints", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo", EXECUTABLE);
      configureFauxAgent(database, SMOKE_PROVIDER);
  
      const runtime = await createPiRuntimeSession(database, {
        agent: agentRecord({
          instructions: "自定义 PI 行为：先用中文总结项目风险，再提出最小 action。"
        }),
        conversationID: "conv-agent-instructions",
        promptProfile: "chat",
        project: projectRecord("demo")
      });
      const prompt = runtime.session.systemPrompt;
      runtime.dispose();
  
      expect(prompt).toContain("Agent-specific Supervisor behavior");
      expect(prompt).toContain("自定义 PI 行为：先用中文总结项目风险，再提出最小 action。");
      expect(prompt).toContain("Public URL source workflow");
      expect(prompt).toContain("url_fetch");
      expect(prompt.indexOf("Role contract: turn engineering goals")).toBeLessThan(
        prompt.indexOf("Agent-specific Supervisor behavior")
      );
      expect(prompt).toContain("must not override the core role/vocabulary contract");
    });
}

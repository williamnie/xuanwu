import { expect, test } from "bun:test";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { createAgentProfile } from "../../db/repositories/agentProfiles.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { getIssueAsWork, issueIDToWorkID, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import type { TestFixture } from "./workApi.testFixture.ts";

export function registerReturnsStableErrorsForIllegalCases(testScope: TestFixture) {
  const { work, workApi, readyProvider, audit, rowCount, adapterAudits, addDependency } = testScope;
  test("returns stable errors for illegal state, missing Work and untrusted request gate input", async () => {
      const { db, api } = await workApi();
      const done = createIssue(db, { project_id: "demo", status: "done", title: "Already done" });
      const revision = (await api.get(work(done.id))).body.work.revision;
  
      expect(await api.post(`${work(done.id)}/actions/cancel`, { audit: audit("illegal-cancel", "supervisor"), expected_revision: revision }))
        .toMatchObject({
          status: 409,
          body: {
            code: "work_mutation_rejected",
            message: "Work mutation rejected",
            violations: ["illegal Work transition done -> cancelled"],
            work: { status: "done" }
          }
        });
      expect(await api.get(work("xw:work:issues:999999"))).toEqual(expect.objectContaining({
        status: 404, body: { code: "work_not_found", message: "Work not found" }
      }));
      expect(await api.get("/api/works?page_size=101")).toEqual(expect.objectContaining({
        status: 400, body: { code: "invalid_request", message: "page_size must not exceed 100" }
      }));
      expect(await api.post("/api/works", {
        audit: { ...audit("request-gate", "supervisor"), gate: { decision: "allow" } },
        goal: "Must not create",
        project_id: "demo",
        title: "Must not create"
      })).toEqual(expect.objectContaining({ status: 400, body: { code: "invalid_request", message: "Unsupported fields: gate" } }));
      expect(await api.post("/api/works", {
        audit: audit("objective-create", "supervisor"), goal: "Objective goal", project_id: "demo", title: "Objective", type: "objective"
      })).toEqual(expect.objectContaining({
        status: 409,
        body: { code: "work_authority_restriction", message: "objective Work creation is unavailable while Issues remain the write authority" }
      }));
      expect(adapterAudits(db)).toContainEqual(expect.objectContaining({ event_id: "illegal-cancel", operation: "cancel", outcome: "rejected" }));
      expect(rowCount(db, "issues")).toBe(1);
    });
  
  test("declares audited readiness requirements without expanding Work Detail", async () => {
      const { db, api } = await workApi();
      const source = createIssue(db, { project_id: "demo", status: "done", title: "Source release" });
      const downstream = createIssue(db, { project_id: "demo", status: "todo", title: "Live cleanup" });
      addDependency(db, downstream.id, source.id);
      const workID = issueIDToWorkID(downstream.id);
      const payload = {
        audit: audit("readiness-v1", "supervisor"),
        requirements: [{
          environment: "production",
          migration_gate: "G4",
          release_window: "W2",
          required_stage: "gate_passed",
          runtime_revision: "v0.1.0-760-g9f1e2d3",
          source_revision: "9f1e2d3",
          source_work_id: issueIDToWorkID(source.id)
        }],
        schema_version: 1,
        work_id: workID
      };
  
      expect(await api.put(`${work(workID)}/readiness-requirements`, payload)).toMatchObject({
        status: 200,
        body: {
          mutation: { replayed: false },
          readiness: {
            current_stage: "source_ready",
            missing_evidence: ["deployed:production:v0.1.0-760-g9f1e2d3", "observed:production:W2", "gate_passed:G4"],
            ready: false,
            status: "waiting"
          }
        }
      });
      expect(await api.put(`${work(workID)}/readiness-requirements`, payload)).toMatchObject({ status: 200, body: { mutation: { replayed: true } } });
      expect((await api.get(work(workID))).body).toMatchObject({ decision: { owner: "pi" }, work: { id: workID } });
    });
  
  test("creates and patches per-Work Agent Profiles with effective provider and running lock", async () => {
      const { db, api } = await workApi("demo", {
        codex: readyProvider("codex"),
        claude: readyProvider("claude"),
        "pi-coding-agent": readyProvider("pi-coding-agent"),
        qoder: readyProvider("qoder")
      });
      createAgentProfile(db, { id: "codex-work", name: "Codex Work", provider: "codex", model: "gpt-5.6" });
      createAgentProfile(db, { id: "claude-work", name: "Claude Work", provider: "claude", model: "claude-sonnet" });
      createAgentProfile(db, { id: "pi-work", name: "Pi Work", provider: "pi-coding-agent", model: "" });
      createAgentProfile(db, { id: "qoder-work", name: "Qoder Work", provider: "qoder", model: "performance" });
      db.sqlite.run("update projects set default_agent_profile_id='codex-work' where id='demo'");
      const createWith = async (eventID: string, profile: string, goal: string, title: string) => (await api.post("/api/works", {
        audit: audit(eventID, "user"), agent_profile_id: profile, goal, project_id: "demo", status: "triage", title, type: "engineering_task"
      })).body.work;
  
      expect(await createWith("work-inherited", "", "inherit default", "Inherited")).toMatchObject({
        agent_profile_id: "",
        effective_provider: "codex",
        effective_agent_profile: { id: "codex-work", provider: "codex", source: "project_default" }
      });
      const claudeWork = await createWith("work-claude", "claude-work", "use Claude", "Claude Work");
      expect(claudeWork).toMatchObject({
        agent_profile_id: "claude-work",
        effective_provider: "claude",
        effective_agent_profile: { id: "claude-work", model: "claude-sonnet", source: "work" }
      });
      expect(await createWith("work-pi", "pi-work", "use Pi provider default", "Pi Work")).toMatchObject({
        agent_profile_id: "pi-work",
        effective_provider: "pi-coding-agent",
        effective_agent_profile: { id: "pi-work", model: "", source: "work" }
      });
      expect(await createWith("work-qoder", "qoder-work", "use Qoder performance", "Qoder Work")).toMatchObject({
        agent_profile_id: "qoder-work",
        effective_provider: "qoder",
        effective_agent_profile: { id: "qoder-work", model: "performance", source: "work" }
      });
  
      expect((await api.patch(work(claudeWork.id), {
        audit: audit("work-switch", "user"), expected_revision: claudeWork.revision, agent_profile_id: "codex-work"
      })).body).toMatchObject({ work: { agent_profile_id: "codex-work", effective_provider: "codex", effective_agent_profile: { source: "work" } } });
      expect(await api.post("/api/works", {
        audit: audit("work-invalid-profile", "user"), agent_profile_id: "missing-profile", goal: "must fail", project_id: "demo", title: "Invalid profile"
      })).toMatchObject({ status: 400, body: { code: "invalid_agent_profile" } });
  
      const issueID = workIDToIssueID(String(claudeWork.id));
      db.sqlite.run("update issues set status='in_progress' where id=?", [issueID]);
      expect(await api.patch(work(claudeWork.id), {
        audit: audit("work-running-same-profile", "user"), expected_revision: getIssueAsWork(db, issueID)!.revision, agent_profile_id: "codex-work"
      })).toMatchObject({ status: 200, body: { work: { agent_profile_id: "codex-work", status: "in_progress", title: "Claude Work" } } });
      const revision = getIssueAsWork(db, issueID)!.revision;
      expect(await api.patch(work(claudeWork.id), {
        audit: audit("work-running-planning-lock", "user"), expected_revision: revision, title: "Must not change"
      })).toMatchObject({
        status: 409,
        body: {
          code: "work_mutation_rejected",
          violations: ["title、description 和 depends_on_issue_ids 只能在未开始的 triage 或 todo Issue 上更新"]
        }
      });
      expect(await api.patch(work(claudeWork.id), {
        audit: audit("work-running-lock", "user"), expected_revision: revision, agent_profile_id: ""
      })).toEqual(expect.objectContaining({
        status: 409, body: { code: "running_work_profile_locked", message: "running Work agent_profile_id cannot be changed" }
      }));
      expect(getIssue(db, issueID)?.agent_profile_id).toBe("codex-work");
    });
}

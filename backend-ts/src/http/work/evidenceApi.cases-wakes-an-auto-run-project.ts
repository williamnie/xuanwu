import { expect, test } from "bun:test";
import { getIssue } from "../../db/repositories/issues.ts";
import { declareIssueReadinessRequirements } from "../../domain/readiness/contracts.ts";
import { issueIDToWorkID } from "../../domain/work/issueAdapter.ts";
import { isProjectLoopActive } from "../../runner/projectLoopManager.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./evidenceApi.testFixture.ts";

export function registerWakesAnAutoRunProjectCases(testScope: TestFixture) {
  const { fixture, insertIssue, postReadinessEvidence, readinessEvidence, timestamp, ReadinessExecutionProvider, addReadinessDependency, waitFor } = testScope;
  test("wakes an auto-run project when new readiness Evidence makes a downstream Issue eligible", async () => {
      const db = await fixture();
      const provider = new ReadinessExecutionProvider();
      const projectID = "readiness-wake";
      try {
        db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
        values (?, ?, ?, 'codex', 1, ?, ?)`, [
          projectID, projectID, "/tmp/readiness-wake", timestamp(0), timestamp(0)
        ]);
        const sourceID = insertIssue(db, "Runtime release", "done", projectID);
        const downstreamID = insertIssue(db, "Live-dependent cleanup", "todo", projectID);
        addReadinessDependency(db, downstreamID, sourceID, projectID);
        declareIssueReadinessRequirements(db, downstreamID, {
          audit: {
            actor: { id: "release-controller", kind: "system" },
            correlation_id: "release-760:wake",
            event_id: "release-760:wake:requirements",
            occurred_at: timestamp(10),
            reason: "Require the production runtime stamp before claim"
          },
          requirements: [{
            environment: "production",
            release_window: "W2",
            required_stage: "deployed",
            runtime_revision: "v0.1.0-760-g9f1e2d3",
            source_revision: "9f1e2d3",
            source_work_id: issueIDToWorkID(sourceID)
          }],
          schema_version: 1,
          work_id: issueIDToWorkID(downstreamID)
        });
        const router = createDefaultRouter({ database: db, providers: { codex: provider } });
  
        const response = await postReadinessEvidence(router, sourceID, readinessEvidence(sourceID, "release-760-wake"));
        await waitFor(() => provider.inputs.length === 1);
  
        expect(response.status).toBe(200);
        expect(provider.inputs[0]).toMatchObject({ issueId: downstreamID, projectId: projectID });
        expect(getIssue(db, downstreamID)).toMatchObject({ attempt_count: 1, status: "in_progress" });
      } finally {
        await waitFor(() => !isProjectLoopActive(projectID));
        db.close();
      }
    });
}

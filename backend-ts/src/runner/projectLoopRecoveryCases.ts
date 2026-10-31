import { expect, test } from "bun:test";

import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";

import {
  FAKE,
  ScriptedProvider,
  openFixtureDatabase,
  PROVIDER_FAILURE,
  addProject,
  addIssue,
  runOnce,
  promptFor
} from "./projectLoopTestFixtures.ts";

export function registerProjectLoopRecoveryCases() {
  test("keeps skill intent context small and avoids dumping the global skill registry", async () => {
    const prompt = await promptFor({
      recommended_skill_intents_json: JSON.stringify(["frontend-ui", "css-layout", "react-component-maintenance"]),
      title: "frontend issue"
    });

    expect(prompt).toContain("## Skill Intent Context");
    expect(prompt).toContain(`Recommended skill intents: ["frontend-ui","css-layout","react-component-maintenance"]`);
    expect(prompt).not.toContain("Available skills metadata");
    expect(prompt).not.toContain("babysit-repo");
  });

  test("keeps provider failures as Run facts until PI decides the Issue", async () => {
    const db = await openFixtureDatabase();
    const provider = new ScriptedProvider(FAKE, { fail: PROVIDER_FAILURE });
    addProject(db, "demo", provider.id);
    const issueId = addIssue(db, "demo", "provider fails");

    await runOnce(db, provider);

    const run = listIssueRuns(db, issueId).at(-1);
    expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress", error: "" });
    expect(run).toMatchObject({
      status: "failed",
      exit_reason: "provider_reported_failed",
      error: "provider failed CODEX_API_KEY=[redacted]"
    });
    expect(run?.error).not.toContain("fixture-secret");
    expect(run?.ended_at).not.toBe("");
    expect(listIssueEvents(db, issueId, { types: ["issue.pi_acceptance_requested.v1"] })).toHaveLength(1);
  });
}

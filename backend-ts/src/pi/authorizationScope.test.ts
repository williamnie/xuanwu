import { describe, expect, test } from "bun:test";
import { matchPiAuthorizationScope } from "./authorizationScope.ts";
import type { PiActionEnvelope } from "./actionGate.ts";

const BASE: PiActionEnvelope = {
  action_type: "issue.comment",
  issue_id: 7,
  payload: {},
  project_id: "demo",
  requires_confirmation: false,
  risk_level: "low",
  source: "pi_tool"
};

describe("PI authorization scope matcher", () => {
  test("matches issue_ids and project_id scopes with reasons", () => {
    expect(matchPiAuthorizationScope(BASE, { issue_ids: [7, 8], project_id: "demo" }))
      .toEqual({ matched: true, reason: "scope matched issue 7 in project demo" });

    expect(matchPiAuthorizationScope({ ...BASE, issue_id: 0 }, { project_id: "demo" }))
      .toEqual({ matched: true, reason: "scope matched project demo" });
  });

  test("rejects cross-project and empty scopes with reasons", () => {
    expect(matchPiAuthorizationScope({ ...BASE, project_id: "other" }, { issue_ids: [7], project_id: "demo" }))
      .toEqual({ matched: false, reason: "project scope demo does not match action project other" });

    expect(matchPiAuthorizationScope(BASE, {}))
      .toEqual({ matched: false, reason: "authorization scope is empty" });
    expect(matchPiAuthorizationScope(BASE, undefined))
      .toEqual({ matched: false, reason: "authorization scope is empty" });
  });

  test("matches goal scope through its associated issue_ids", () => {
    expect(matchPiAuthorizationScope(BASE, { goal_id: "night-run", issue_ids: [7, 8], project_id: "demo" }))
      .toEqual({ matched: true, reason: "scope matched goal night-run issue 7" });

    expect(matchPiAuthorizationScope({ ...BASE, goal_id: "night-run", issue_id: 9 }, { goal_id: "night-run", issue_ids: [7, 8], project_id: "demo" }))
      .toEqual({ matched: false, reason: "goal scope night-run issues 7,8 do not match action issue 9" });
  });
});

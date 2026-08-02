import { describe, expect, test } from "bun:test";
import { gatePiActionEnvelope } from "./actionGate.ts";
import { normalizePiActionEnvelope } from "./actionEnvelope.ts";
import { piInternalReadAuthorization } from "./internalReadAuthorization.ts";

describe("PI internal read authorization", () => {
  test("allows project-scoped Session/repository reads but keeps issue_read on the exact Issue", () => {
    const policy = piInternalReadAuthorization({
      issueID: 841,
      projectID: "demo",
      toolNames: ["issue_read", "session_read_summary", "repo_search"]
    });

    expect(decision(policy, "session.read_summary", { session_key: "codex:841" })).toBe("execute");
    expect(decision(policy, "repo.search", { query: "provider" })).toBe("execute");
    expect(decision(policy, "issue.read", { id: 841 }, 841)).toBe("execute");
    expect(decision(policy, "issue.read", { id: 842 }, 842)).toBe("deny");
  });
});

function decision(
  policy: ReturnType<typeof piInternalReadAuthorization>,
  actionType: string,
  payload: Record<string, unknown>,
  issueID?: number
) {
  return gatePiActionEnvelope(normalizePiActionEnvelope({
    action_type: actionType,
    issue_id: issueID,
    payload,
    project_id: "demo",
    source: "test"
  }), policy).decision;
}

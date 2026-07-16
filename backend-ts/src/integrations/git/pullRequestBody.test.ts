import { describe, expect, test } from "bun:test";
import { buildHandoffPullRequestBody } from "./pullRequestBody.ts";

describe("Handoff pull request body", () => {
  test("combines delivery, verification, review, tracker, and status without leaking credentials", () => {
    const body = buildHandoffPullRequestBody({
      branch: "xw/676-adapter",
      commit: "abc123",
      review: { required: true, summary: "Reviewers: backend-team" },
      status_link: { label: "Runner issue 676", url: "http://127.0.0.1:3008/issues/676" },
      summary: "Add adapters TOKEN=provider-secret at /Users/example/private",
      tracker_update: "Update runner issue after delivery",
      verification: [
        { command: "bun test provider.test.ts", outcome: "passed", summary: "fake API passed" },
        { command: "live sandbox", outcome: "skipped", summary: "not configured" }
      ]
    });

    expect(body).toContain("## Summary");
    expect(body).toContain("## Verification");
    expect(body).toContain("## Review");
    expect(body).toContain("## Tracker update");
    expect(body).toContain("[Runner issue 676](http://127.0.0.1:3008/issues/676)");
    expect(body).toContain("- [x] `bun test provider.test.ts` — passed");
    expect(body).not.toContain("provider-secret");
    expect(body).not.toContain("/Users/example/private");
  });

  test("rejects status links carrying credential query parameters", () => {
    expect(() => buildHandoffPullRequestBody({
      branch: "xw/676",
      commit: "abc123",
      review: { required: false, summary: "Not required" },
      status_link: { url: "https://runner.example/issues/676?token=secret" },
      summary: "Summary",
      tracker_update: "None",
      verification: []
    })).toThrow("credential query parameters");
  });
});

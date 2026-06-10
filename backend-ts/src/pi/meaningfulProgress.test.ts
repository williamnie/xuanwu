import { describe, expect, test } from "bun:test";
import { detectMeaningfulProgress } from "./meaningfulProgress.ts";

describe("meaningful progress detector", () => {
  test("counts agent output, completed commands, state updates, verification, commit, and issue update as progress", () => {
    const result = detectMeaningfulProgress({
      baseline: {
        git_diff_hash: "old",
        issue: { status: "in_progress", updated_at: "2026-06-10T02:00:00Z" },
        run: { status: "in_progress", updated_at: "2026-06-10T02:00:00Z" },
        session: { status: "running", updated_at: "2026-06-10T02:00:00Z" }
      },
      current: {
        git_diff_hash: "new",
        issue: { status: "pending_verification", updated_at: "2026-06-10T02:05:00Z" },
        run: { status: "done", updated_at: "2026-06-10T02:05:00Z" },
        session: { status: "idle", updated_at: "2026-06-10T02:05:00Z" }
      },
      events: [
        { type: "issue.log", payload: { type: "agent_message", text: "Implemented the focused fix." } },
        { type: "issue.log", payload: { command: "bun test backend-ts/src/pi/x.test.ts", status: "completed" } },
        { type: "issue.log", payload: { text: "git commit -m \"fix(pi): 修复恢复检测\"" } },
        { type: "issue.log", payload: { text: "codex-issue-runner issue update --id 303 --status done --json" } }
      ]
    });

    expect(result.has_progress).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "agent_message",
      "command_completed",
      "git_diff_changed",
      "issue_status_updated",
      "run_updated",
      "session_updated",
      "verification_signal",
      "commit_signal",
      "issue_update_signal"
    ]));
  });

  test("ignores token usage, repeated errors, and empty turns", () => {
    const result = detectMeaningfulProgress({
      baseline: { git_diff_hash: "same", issue: { status: "in_progress", updated_at: "2026-06-10T02:00:00Z" } },
      current: { git_diff_hash: "same", issue: { status: "in_progress", updated_at: "2026-06-10T02:00:00Z" } },
      events: [
        { type: "issue.log", payload: { type: "token_usage", input_tokens: 120, output_tokens: 8 } },
        { type: "issue.log", payload: { type: "error", error: "HTTP 429: too many requests" } },
        { type: "issue.log", payload: { type: "error", error: "HTTP 429: too many requests" } },
        { type: "issue.log", payload: { type: "turn_completed", text: "" } }
      ]
    });

    expect(result.has_progress).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.ignored_reasons).toEqual(expect.arrayContaining([
      "token_usage",
      "repeated_error",
      "empty_turn"
    ]));
  });
});

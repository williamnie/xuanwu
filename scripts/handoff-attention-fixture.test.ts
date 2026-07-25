import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIssue783Fixture } from "./handoff-attention-fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("Issue 783 Handoff and Attention fixture", () => {
  test("passes every attribution/lifecycle assertion and writes replayable artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-783-fixture-test-"));
    roots.push(root);

    const report = await runIssue783Fixture(root);
    const persistedReport = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
    const replay = await readFile(join(root, "replay.md"), "utf8");
    const manifest = JSON.parse(await readFile(join(root, "fixture-manifest.json"), "utf8"));
    const handoff = JSON.parse(await readFile(join(root, "handoff-results.json"), "utf8"));
    const attention = JSON.parse(await readFile(join(root, "attention-results.json"), "utf8"));
    const timeline = (await readFile(join(root, "timeline.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));

    expect(report.result).toBe("passed");
    expect(persistedReport).toEqual(report);
    expect(report.artifact_refs).toEqual([
      "fixture-manifest.json",
      "handoff-results.json",
      "attention-results.json",
      "timeline.jsonl",
      "replay.md"
    ]);
    expect(replay).toContain("bun scripts/handoff-attention-fixture.ts exercise");
    expect(replay).toContain("bun test");
    expect(report.assertions).toHaveLength(9);
    expect(report.assertions.every((item) => item.passed)).toBeTrue();
    expect(handoff.clean_commit.changed_files).toEqual(manifest.handoff_files.clean_commit);
    expect(handoff.shared_dirty_tree.changed_files).toEqual(manifest.handoff_files.shared_dirty_tree);
    expect(handoff.current_work_untracked.changed_files).toEqual(manifest.handoff_files.current_work_untracked);
    expect(handoff.current_work_untracked.snapshot_sha256)
      .toBe(handoff.current_work_untracked_replay.snapshot_sha256);
    expect(handoff.uncertain_attribution.risks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "handoff_attribution_uncertainty", severity: "high" })
    ]));
    expect(attention.human_help).toMatchObject({
      active_after: 0,
      active_before: 1,
      final_status: "resolved"
    });
    expect(attention.human_help.timeline.map((event) => event.action))
      .toEqual(["create", "acknowledge", "resolve", "close"]);
    expect(attention.auto_recovery).toMatchObject({
      active_after: 0,
      command_event_count: 0,
      stale_approval_count: 0
    });
    expect(attention.completed_work_active_stale_attention).toBe(0);
    expect(timeline.every((event) => event.target && event.reason && event.at)).toBeTrue();
  }, 30_000);
});

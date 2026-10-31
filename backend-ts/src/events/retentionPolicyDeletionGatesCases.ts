import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { evaluateEventRetention } from "./retentionPolicy.ts";
import { ADR_PATH, eventOf, eligibleInput } from "./retentionPolicyTestFixtures.ts";

export function registerRetentionPolicyDeletionGatesCases() {
  test("protects handoff evidence and unresolved activity references", () => {
    const input = eligibleInput();
    const result = evaluateEventRetention({
      ...input,
      references: {
        handoff_evidence: true,
        unresolved_refs: ["pi_guardian_event_inbox:42", "pi_activity:issue_event:100"]
      }
    });

    expect(result.action).not.toBe("delete_candidate");
    expect(result.blockers).toEqual(expect.arrayContaining(["handoff_evidence", "unresolved_reference"]));
  });

  test("fails closed when summary, archive, gate, or event classification is missing", () => {
    const input = eligibleInput();
    const missing = evaluateEventRetention({
      event: input.event,
      now: input.now,
      references: { handoff_evidence: false, unresolved_refs: [] },
      run: input.run
    });
    expect(missing.blockers).toEqual(expect.arrayContaining([
      "summary_watermark_missing", "archive_receipt_missing", "destructive_gate_missing"
    ]));

    const unknown = evaluateEventRetention({
      ...input,
      event: { ...input.event, event_type: "issue.future_unknown", raw_method: "" }
    });
    expect(unknown.blockers).toEqual(expect.arrayContaining(["review_required", "source_deletion_disabled"]));
    expect(unknown.action).not.toBe("delete_candidate");
  });

  test("keeps state, audit, and delivery evidence source deletion disabled by default", () => {
    for (const event of [
      eventOf("issue.status_changed"),
      eventOf("issue.log", "turn/completed"),
      eventOf("issue.verification_reviewed")
    ]) {
      const result = evaluateEventRetention({
        ...eligibleInput(),
        event: { ...event, created_at: "2010-01-01T00:00:00Z" }
      });
      expect(result.blockers).toContain("source_deletion_disabled");
      expect(result.action).not.toBe("delete_candidate");
    }
  });

  test("keeps the canonical source-of-truth, watermark, hold, and deletion gates documented", () => {
    const adr = readFileSync(ADR_PATH, "utf8");
    for (const marker of [
      "当前 source of truth",
      "summary watermark",
      "pin",
      "legal hold",
      "failed run",
      "Handoff Evidence",
      "双写/双读期限",
      "最终删除门禁",
      "report_only"
    ]) expect(adr).toContain(marker);
  });
}

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { createPiAction, createPiActionEvent } from "../../db/repositories/pi.ts";
import { auditPiDecisionConsolidation } from "./consolidationAudit.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("PI decision consolidation delete gate", () => {
  test("reports data parity separately from non-LLM destructive authorization", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-decision-consolidation-audit-"));
    roots.push(root);
    const dbPath = join(root, "runner-copy.db");
    const reportPath = join(root, "reports", "attention-audit.json");
    const db = await openDatabase({ dbPath, stateDir: root });
    createPiAction(db, {
      action_type: "issue.read",
      gate_decision: "execute",
      id: "audited-action",
      idempotency_key: "audited-action",
      status: "completed"
    });
    createPiActionEvent(db, { action_id: "audited-action", event_type: "execution_result" });
    db.close();

    const report = auditPiDecisionConsolidation({ dbPath, reportPath });
    expect(report).toMatchObject({
      contract: "xw.pi-decision-consolidation.v1",
      data_gate_passed: true,
      delete_gate: {
        blockers: expect.arrayContaining([expect.stringContaining("P11.09")]),
        destructive_delete_authorized: false
      },
      gaps: {
        actions_without_audit_events: 0,
        approved_proposal_actions_without_action_link: 0,
        proposals_without_attention_source: 0
      },
      quick_check: "ok"
    });
    expect(existsSync(reportPath)).toBe(true);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({ data_gate_passed: true });
  });
});

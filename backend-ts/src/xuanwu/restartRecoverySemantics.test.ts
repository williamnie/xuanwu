import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RESTART_RECOVERY_CARRIERS,
  RESTART_RECOVERY_INVARIANTS,
  restartRecoveryCarrier
} from "./restartRecoverySemantics.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ADR_PATH = resolve(REPO_ROOT, "docs/architecture/xuanwu/0069-restart-recovery-invariants.md");

describe("Xuanwu restart recovery semantics", () => {
  test("locks one current authority and a fail-closed repair path for every recovery carrier", () => {
    expect(RESTART_RECOVERY_CARRIERS.map((carrier) => carrier.id)).toEqual([
      "work", "run", "automation", "approval", "im_reply_outbox", "tracker_outbox"
    ]);
    for (const carrier of RESTART_RECOVERY_CARRIERS) {
      expect(carrier.authority).not.toBe("");
      expect(carrier.startup_reconciler).not.toBe("");
      expect(carrier.lost_lease).not.toBe("");
      expect(carrier.split_brain).not.toBe("");
      expect(carrier.terminal_rule).not.toBe("");
      expect(carrier.repair).not.toBe("");
    }
    expect(restartRecoveryCarrier("automation").split_brain).toContain("lease token CAS");
    expect(restartRecoveryCarrier("approval").lost_lease).toContain("fail closed");
    expect(restartRecoveryCarrier("im_reply_outbox").lost_lease).toContain("no durable IM dispatch lease/fence");
    expect(() => restartRecoveryCarrier("unknown" as never)).toThrow("unsupported restart recovery carrier");
  });

  test("makes idempotency, terminal monotonicity, deterministic gate, and ambiguous delivery explicit", () => {
    expect(RESTART_RECOVERY_INVARIANTS).toEqual(expect.arrayContaining([
      expect.stringContaining("idempotent"),
      expect.stringContaining("Terminal Work, Run, Approval, Automation, and Outbox"),
      expect.stringContaining("deterministic permission"),
      expect.stringContaining("Ambiguous external delivery fails closed")
    ]));
  });

  test("keeps the operational runbook and migration boundary reviewable", () => {
    const adr = readFileSync(ADR_PATH, "utf8");
    for (const heading of [
      "不变量", "启动 reconciliation 顺序", "lost lease", "split-brain 仲裁", "repair actions", "Runbook",
      "source of truth", "双读", "双写", "回滚", "最终删除门禁"
    ]) expect(adr).toContain(heading);
    expect(adr).toContain("IM Reply Outbox");
    expect(adr).toContain("terminal 状态不回退");
  });
});

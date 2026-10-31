import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROCESS_GROUP_MEMORY_BUDGETS,
  resolveRecoveredProcessGroupMemoryAlerts,
  type ProcessMemoryBudgetAlert,
  writeProcessGroupMemoryAlert
} from "./processGroupMemory.ts";

import { openDatabase } from "../db/database.ts";
import { listPiGuardianAlerts } from "../db/repositories/pi.ts";
import { ackPiGuardianAlert, upsertPiGuardianAlert } from "../db/repositories/pi/guardianAlerts.ts";

import { trackDatabase, MIB } from "./processGroupMemoryTestFixtures.ts";

export function registerProcessGroupMemoryAlertsCases() {
  test("publishes explicit soft and hard thresholds instead of the former one-gigabyte ceiling", () => {
    expect(PROCESS_GROUP_MEMORY_BUDGETS).toMatchObject({
      alert_after_ms: { hard: 180_000, soft: 180_000 },
      consecutive: { hard: 180, soft: 180 },
      idle_main_rss_bytes: { hard: 384 * MIB, soft: 320 * MIB },
      idle_group_rss_p95_bytes: { hard: 448 * MIB, soft: 384 * MIB },
      active_run_group_rss_p95_bytes: { hard: 896 * MIB, soft: 768 * MIB },
      post_run_delta_bytes: { hard: 96 * MIB },
      soak_drift_bytes: { hard: 128 * MIB }
    });
    expect(JSON.stringify(PROCESS_GROUP_MEMORY_BUDGETS)).not.toContain(String(1024 * MIB));
  });

  test("deduplicates a redacted budget alert into the existing Guardian Attention surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-alert-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root }).then(trackDatabase);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const alert: ProcessMemoryBudgetAlert = {
      budget: { hard_bytes: 320 * MIB, status: "hard_exceeded" },
      level: "hard",
      phase: "idle",
      sample: { top_by_rss: [{ owner: "runner", pid: 50, role: "runner", rss_bytes: 330 * MIB }] }
    };
    try {
      writeProcessGroupMemoryAlert(database, alert);
      writeProcessGroupMemoryAlert(database, alert);
      const stored = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        run_group_id: "runner-memory",
        severity: "urgent",
        status: "open",
        ui_visible: 1
      });
      expect(stored[0]?.evidence_json).toContain('"pid":50');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("consolidates soft and hard transitions into one incident and reopens only on escalation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-levels-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root }).then(trackDatabase);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeProcessGroupMemoryAlert(database, {
        budget: { status: "soft_exceeded" }, level: "soft", phase: "idle", sample: {}
      });
      let incident = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" })[0]!;
      expect(incident).toMatchObject({ run_group_id: "runner-memory", severity: "high", status: "open" });
      ackPiGuardianAlert(database, incident.id);

      writeProcessGroupMemoryAlert(database, {
        budget: { status: "soft_exceeded" }, level: "soft", phase: "idle", sample: {}
      });
      incident = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" })[0]!;
      expect(incident).toMatchObject({ severity: "high", status: "acked" });

      writeProcessGroupMemoryAlert(database, {
        budget: { status: "hard_exceeded" }, level: "hard", phase: "idle", sample: {}
      });
      const active = [
        ...listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "open" }),
        ...listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "acked" })
      ];
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ run_group_id: "runner-memory", severity: "urgent", status: "open" });
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("consolidates legacy per-level incidents without losing an acknowledgement of the peak", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-legacy-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root }).then(trackDatabase);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      upsertPiGuardianAlert(database, {
        alert_type: "runner_process_group_memory_budget", evidence_json: {}, message: "legacy soft",
        run_group_id: "runner-memory:idle:soft", severity: "high", status: "open"
      });
      upsertPiGuardianAlert(database, {
        alert_type: "runner_process_group_memory_budget", evidence_json: {}, message: "legacy hard",
        run_group_id: "runner-memory:idle:hard", severity: "urgent", status: "acked"
      });

      writeProcessGroupMemoryAlert(database, {
        budget: { status: "soft_exceeded" }, level: "soft", phase: "idle", sample: {}
      });

      const active = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "acked" });
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ run_group_id: "runner-memory", severity: "urgent" });
      expect(listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "resolved" }))
        .toHaveLength(2);
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves open and acknowledged memory incidents after a healthy sample", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-recovery-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root }).then(trackDatabase);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      upsertPiGuardianAlert(database, {
        alert_type: "runner_process_group_memory_budget", evidence_json: {}, message: "open memory alert",
        run_group_id: "runner-memory", severity: "urgent", status: "open"
      });
      upsertPiGuardianAlert(database, {
        alert_type: "runner_process_group_memory_budget", evidence_json: {}, message: "legacy acked alert",
        run_group_id: "runner-memory:run:hard", severity: "urgent", status: "acked"
      });

      const resolved = resolveRecoveredProcessGroupMemoryAlerts(database, {
        budget: { status: "within_budget" }, phase: "idle", sampled_at: "2026-07-21T03:46:49Z"
      });

      expect(resolved).toBe(2);
      expect(listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget", status: "resolved" }))
        .toHaveLength(2);
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reopens the canonical memory incident instead of creating alert history on every recovery flap", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-memory-reopen-"));
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root }).then(trackDatabase);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeProcessGroupMemoryAlert(database, {
        budget: { status: "soft_exceeded" }, level: "soft", phase: "idle", sample: {}
      });
      const original = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" })[0]!;
      resolveRecoveredProcessGroupMemoryAlerts(database, {
        budget: { status: "within_budget" }, phase: "idle", sampled_at: "2026-07-21T03:46:49Z"
      });
      writeProcessGroupMemoryAlert(database, {
        budget: { status: "hard_exceeded" }, level: "hard", phase: "idle", sample: {}
      });

      const stored = listPiGuardianAlerts(database, { alertType: "runner_process_group_memory_budget" });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        id: original.id,
        run_group_id: "runner-memory",
        severity: "urgent",
        status: "open"
      });
    } finally {
      warn.mockRestore();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

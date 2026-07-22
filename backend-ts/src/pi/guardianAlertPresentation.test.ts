import { describe, expect, test } from "bun:test";
import type { PiGuardianAlert } from "../db/repositories/pi/guardianAlerts.ts";
import { guardianAlertPresentation } from "./guardianAlertPresentation.ts";

const NOW = new Date("2026-07-21T04:00:00Z");

describe("Guardian alert presentation", () => {
  test("explains what failed, where it failed, and that PI is handling a fresh incident", () => {
    const display = guardianAlertPresentation(alert({
      alert_type: "outbox_stalled",
      created_at: "2026-07-21T03:55:00Z",
      issue_id: 771,
      project_id: "codex-issue-runner"
    }), NOW);

    expect(display).toMatchObject({
      component: "通知发送队列",
      handling: "pi_handling",
      historical: false,
      pi_can_handle: true,
      requires_user: false,
      state_label: "当前故障 · PI 自动处理中",
      title: "通知发送暂时延迟"
    });
    expect(display.location).toContain("项目 codex-issue-runner");
    expect(display.location).toContain("Issue #771");
    expect(display.user_action).toContain("当前无需操作");
  });

  test("marks terminal incidents as history and persistent memory incidents as user action", () => {
    expect(guardianAlertPresentation(alert({ status: "resolved" }), NOW)).toMatchObject({
      active: false,
      handling: "historical",
      historical: true,
      requires_user: false,
      state_label: "历史记录 · 已恢复"
    });
    expect(guardianAlertPresentation(alert({
      alert_type: "runner_process_group_memory_budget",
      created_at: "2026-07-21T03:40:00Z",
      run_group_id: "runner-memory:idle:hard"
    }), NOW)).toMatchObject({
      component: "Runner 内存监控",
      handling: "user_action_required",
      requires_user: true
    });
    expect(guardianAlertPresentation(alert({
      alert_type: "scheduler_stalled",
      status: "acked"
    }), NOW)).toMatchObject({
      handling: "pi_handling",
      pi_can_handle: true,
      requires_user: false,
      state_label: "已知晓 · 等待来源恢复"
    });
  });

  test("asks the user only after issue watchdog exhausted its recovery budget", () => {
    expect(guardianAlertPresentation(alert({
      alert_type: "issue_watchdog_runnable_without_runtime",
      created_at: "2026-07-20T03:00:00Z",
      issue_id: 773
    }), NOW)).toMatchObject({
      handling: "user_action_required",
      pi_can_handle: false,
      requires_user: true,
      title: "Issue 会话自动恢复未成功"
    });
  });
});

function alert(overrides: Partial<PiGuardianAlert> = {}): PiGuardianAlert {
  return {
    alert_type: "outbox_stalled",
    created_at: "2026-07-21T03:55:00Z",
    direct_feishu_error: "",
    direct_feishu_message_id: "",
    direct_feishu_state: "not_attempted",
    evidence_json: "{}",
    id: "alert-1",
    issue_id: 0,
    max_retry_count: 3,
    message: "outbox stalled: 1 stale item(s)",
    next_retry_at: "",
    project_id: "",
    retry_count: 0,
    run_group_id: "",
    severity: "urgent",
    status: "open",
    ui_visible: 1,
    updated_at: "2026-07-21T03:55:00Z",
    watchdog_seen_at: "2026-07-21T03:55:00Z",
    ...overrides
  };
}

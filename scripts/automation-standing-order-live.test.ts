import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  completeActionAudit,
  equalWatermark,
  eventTypes,
  validRunEventOrder
} from "./automation-standing-order-live.ts";

describe("AGENT-02 live Standing Order assertions", () => {
  test("accepts one terminal execution and restart recovery ordering", () => {
    const normal = events(
      "automation.run_queued.v1",
      "automation.run_claimed.v1",
      "automation.run_succeeded.v1"
    );
    const recovered = events(
      "automation.run_queued.v1",
      "automation.run_claimed.v1",
      "automation.run_lease_expired.v1",
      "automation.run_claimed.v1",
      "automation.run_succeeded.v1"
    );
    expect(validRunEventOrder(normal, "run-1")).toBeTrue();
    expect(validRunEventOrder(recovered, "run-1")).toBeTrue();
    expect(eventTypes(recovered, "run-1")).toHaveLength(5);
  });

  test("requires a fresh claim after restart lease expiry", () => {
    const missingReclaim = events(
      "automation.run_queued.v1",
      "automation.run_claimed.v1",
      "automation.run_lease_expired.v1",
      "automation.run_succeeded.v1"
    );
    expect(validRunEventOrder(missingReclaim, "run-1")).toBeFalse();
  });

  test("rejects duplicate terminal outcomes and detects side-effect drift", () => {
    const duplicate = events(
      "automation.run_queued.v1",
      "automation.run_claimed.v1",
      "automation.run_succeeded.v1",
      "automation.run_succeeded.v1"
    );
    expect(validRunEventOrder(duplicate, "run-1")).toBeFalse();
    expect(equalWatermark(
      { run_count: 1, evidence_count: 1, handoff_count: 1, linked_work_count: 1 },
      { run_count: 2, evidence_count: 2, handoff_count: 2, linked_work_count: 2 }
    )).toBeFalse();
  });

  test("requires actor, reason, correlation, permission and outcome", () => {
    expect(completeActionAudit({
      actor: "automation-scheduler",
      correlation: "automation-run:run-1",
      outcome: "succeeded",
      permission: "deterministic_policy:allow:fixture",
      reason: "local proposal completed"
    })).toBeTrue();
    expect(completeActionAudit({
      actor: "automation-scheduler",
      correlation: "",
      outcome: "succeeded",
      permission: "deterministic_policy:allow:fixture",
      reason: "local proposal completed"
    })).toBeFalse();
  });

  test("restarts only an isolated ./dev.sh runtime", () => {
    const source = readFileSync(new URL("./automation-standing-order-live.ts", import.meta.url), "utf8");
    expect(source).toContain('Bun.spawn(["./dev.sh"]');
    expect(source).toContain('runtime_scope: "isolated ./dev.sh; launchd untouched"');
    expect(source).not.toContain('"launchctl"');
    expect(source).not.toContain("com.xiaobei.codex-issue-runner.core");
  });
});

function events(...types: string[]) {
  return types.map((event_type, index) => ({
    event_id: `event-${index}`,
    event_type,
    occurred_at: `2026-07-25T00:00:0${index}.000Z`,
    run_id: "run-1"
  }));
}

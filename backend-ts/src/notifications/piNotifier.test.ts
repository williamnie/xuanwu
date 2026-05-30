import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/bus.ts";
import type { ProjectFinding } from "../pi/projectFindings.ts";
import { publishNeedsUserFindingNotifications } from "./piNotifier.ts";

describe("PI needs-user notification engine", () => {
  test("publishes redacted needs-user payloads through the event bus", async () => {
    const bus = new EventBus();
    const events = bus.subscribe();
    const finding = findingRecord({
      message: "approval denied CODEX_API_KEY=fixture-secret at /Users/secret/log.txt",
      title: "Needs user at /Users/secret/project"
    });

    const payloads = publishNeedsUserFindingNotifications({
      bus,
      findings: [finding],
      now: new Date("2026-01-01T00:00:00Z"),
      notifyOnNeedsUser: true,
      project: { id: "demo", name: "Demo TOKEN=project-secret" }
    });

    const event = await events.next();
    events.close();
    const payloadText = JSON.stringify(payloads);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      event: "pi.needs_user",
      issue_id: 7,
      project_id: "demo",
      reason: "needs_user"
    });
    expect(event).toMatchObject({ type: "pi.needs_user", issueId: 7, projectId: "demo" });
    expect(event?.payload).toBe(JSON.stringify(payloads[0]));
    expect(payloadText).toContain("[redacted]");
    expect(payloadText).toContain("[redacted-path]");
    expect(payloadText).not.toContain("fixture-secret");
    expect(payloadText).not.toContain("project-secret");
    expect(payloadText).not.toContain("/Users/secret");
  });

  test("skips needs-user notifications when project settings disable them", () => {
    const bus = new EventBus();

    const payloads = publishNeedsUserFindingNotifications({
      bus,
      findings: [findingRecord({ message: "waiting for user input" })],
      notifyOnNeedsUser: false,
      project: { id: "demo", name: "Demo" }
    });

    expect(payloads).toEqual([]);
    expect(bus.subscriberCount()).toBe(0);
  });
});

function findingRecord(input: { message: string; title?: string }): ProjectFinding {
  return {
    category: "needs_user",
    issue_id: 7,
    message: input.message,
    notification: { type: "pi.needs_user", message: input.message },
    project_id: "demo",
    reason: "needs_user",
    severity: "blocked",
    status: "failed",
    title: input.title ?? "Needs user",
    updated_at: "2026-01-01T00:00:00Z"
  };
}

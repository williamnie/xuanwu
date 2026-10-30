import { expect, test } from "bun:test";
import type { TestFixture } from "./issueActionsApi.testFixture.ts";

export function registerLetsAManagedExecutorControlCases(testScope: TestFixture) {
  const { openFixtureDatabase, issueAction, managedExecutorHeaders, insertIssue, insertProject, getIssueStatus, eventWithType } = testScope;
  test("lets a managed executor control a different fixture Issue and records the actor", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueId = insertIssue(database, {
        codexThreadId: "thread-fixture",
        projectId: "demo",
        status: "triage",
        title: "fixture control"
      });
  
      const response = await issueAction(
        database,
        issueId,
        "enqueue",
        undefined,
        managedExecutorHeaders("thread-controller")
      );
  
      expect(response.status).toBe(200);
      expect(getIssueStatus(database, issueId)).toBe("todo");
      const audit = eventWithType(database, "issue.lifecycle_control.v1");
      expect(JSON.parse(audit?.payload ?? "{}")).toMatchObject({
        actor: {
          kind: "managed_executor",
          source: "xuanwu-cli",
          thread_id: "thread-controller"
        },
        after_status: "todo",
        before_status: "triage",
        operation: "enqueue"
      });
    });
}

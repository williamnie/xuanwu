import { expect, test } from "bun:test";

import { completeRunAttemptStart, prepareRunAttempt } from "./service.ts";

import { openFixture, activeRun, attemptCommand, attempts } from "./serviceTestFixtures.ts";

export function registerServiceCanonicalRefsCases() {
  test("session-only resume Attempt（有 session 无 message/turn ref）可完成", async () => {
    const fixture = await openFixture("p1-session-only");
    const run = activeRun(fixture.db, "resumable-session-1", "");
    const command = attemptCommand(fixture.db, run, "resume", "p1-session-only-1", "succeeded");
    const prepared = prepareRunAttempt(fixture.db, command);
    expect(prepared).toMatchObject({ completed: false, should_invoke: true });

    const provider = {
      invocation_ref: "xw:inv:resumable-1",
      provider_session_id: "resumable-session-1"
    };
    expect(completeRunAttemptStart(fixture.db, "p1-session-only-1", provider)).toMatchObject({
      completed: true,
      replayed: false
    });
    expect(attempts(fixture.db, run.issue_run_id).at(-1)).toMatchObject({
      status: "running",
      provider_invocation_ref: "xw:inv:resumable-1",
      provider_session_id: "resumable-session-1",
      provider_turn_id: ""
    });
  });

  test("缺 invocation_ref 时 fail closed（不猜测执行）", async () => {
    const fixture = await openFixture("p1-missing-invocation");
    const run = activeRun(fixture.db, "resumable-session-2", "");
    const command = attemptCommand(fixture.db, run, "resume", "p1-missing-1", "succeeded");
    const prepared = prepareRunAttempt(fixture.db, command);
    expect(prepared.should_invoke).toBe(true);
    expect(() => completeRunAttemptStart(fixture.db, "p1-missing-1", {
      invocation_ref: "",
      provider_session_id: "resumable-session-2",
      provider_turn_id: "turn-x"
    })).toThrow(/invocation_ref is required/);
  });

  test("provider 结果 Session 与 prepared Attempt 不匹配时 fail closed", async () => {
    const fixture = await openFixture("p1-session-mismatch");
    const run = activeRun(fixture.db, "resumable-session-3", "");
    const command = attemptCommand(fixture.db, run, "resume", "p1-mismatch-1", "succeeded");
    const prepared = prepareRunAttempt(fixture.db, command);
    expect(prepared.should_invoke).toBe(true);
    expect(() => completeRunAttemptStart(fixture.db, "p1-mismatch-1", {
      invocation_ref: "xw:inv:1",
      provider_session_id: "unexpected-session",
      provider_turn_id: ""
    })).toThrow(/does not match prepared Attempt/);
  });

  test("resume/recovery 缺 session ref 仍 fail closed（不变量）", async () => {
    const fixture = await openFixture("p1-no-session-resume");
    const run = activeRun(fixture.db, "", "");
    const command = attemptCommand(fixture.db, run, "resume", "p1-no-session-1", "succeeded");
    expect(() => prepareRunAttempt(fixture.db, command)).toThrow(/requires provider session ref/);
  });
}

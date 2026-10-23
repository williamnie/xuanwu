import { expect, test } from "bun:test";
import { transientStatusSnapshot } from "./memoryPolicy.ts";

test("time words in reusable technical guidance are not task status snapshots", () => {
  for (const content of [
    "修改门槛判定且当前业务规格规定阈值本身应通过时。",
    "按当前业务规格将判定改为>=100，并覆盖阈值下方、阈值本身和阈值上方的测试。",
    "本次修复总结的方法适用于相同版本：重新读取规格并验证边界。",
    "Read the specification currently in effect before choosing boundary tests.",
    "When a test fails today, verify the root cause before reusing the fix."
  ]) {
    expect(transientStatusSnapshot(content)).toBe(false);
    expect(transientStatusSnapshot(JSON.stringify({ resolution: content }))).toBe(false);
  }
});

test("task lifecycle and queue snapshots remain rejected, including nested JSON", () => {
  for (const content of [
    "当前任务已完成，根因已修复", "当前 Issue #785 failed，等待人工处理。",
    "本轮任务等待人工处理", "The current run is in_progress", "Currently all issues are done",
    "current status: waiting", "manager cycle observation: idle", "status_counts",
    "active pi_manager sessions", "没有未完成任务", "done=12", "队列为空", "queue 3"
  ]) {
    expect(transientStatusSnapshot(content)).toBe(true);
    expect(transientStatusSnapshot(JSON.stringify({ resolution: content }))).toBe(true);
  }
});

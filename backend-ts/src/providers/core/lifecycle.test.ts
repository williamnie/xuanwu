import { describe, expect, test } from "bun:test";
import { recoverIssueWithProvider } from "../../runner/providerRuntime.ts";
import { ExecutionOnlyProvider, ResumableSessionProvider } from "../testing/conformanceFixtures.ts";

/**
 * P5：核心生命周期 fail closed 与能力判断（不依赖 Provider ID 穷举）。
 * - 恢复能力由 capability（resume_session + recover 方法）决定，非 codex/claude 白名单；
 * - Provider 不支持 resume/interrupt/approval 时拒绝，而不是静默降级。
 */
describe("P5: 恢复能力由 capability 决定（非 ID 穷举）", () => {
  test("execution-only（非 codex/claude）无 resume_session → recover fail closed", async () => {
    const provider = new ExecutionOnlyProvider();
    await expect(
      recoverIssueWithProvider(provider, {
        issueId: 1,
        projectId: "p",
        cwd: "/tmp",
        prompt: "resume",
        session: { provider: "fake-execution-only", sessionId: "sess-1" },
        selectionReason: "test"
      })
    ).rejects.toThrow(/missing capability "resume_session"/);
  });

  test("resumable（无 message/turn ref）可 recover，能力由 capability 表达", async () => {
    const provider = new ResumableSessionProvider();
    const result = await recoverIssueWithProvider(provider, {
      issueId: 1,
      projectId: "p5",
      cwd: "/tmp",
      prompt: "resume",
      session: { provider: "fake-resumable", sessionId: "fake-resumable-session-p5" },
      selectionReason: "test"
    });
    expect(result.session?.sessionId).toBe("fake-resumable-session-p5");
    expect(result.session?.turnId).toBeUndefined();
  });

  test("interrupt 可用性按方法存在性判断（无 interrupt 方法 → 不可用）", () => {
    const executionOnly = new ExecutionOnlyProvider();
    const resumable = new ResumableSessionProvider();
    const hasInterrupt = (p: unknown) => typeof (p as { interrupt?: unknown }).interrupt === "function";
    // 两个均非 codex/claude；capability/method 决定 interrupt 可用性
    expect(hasInterrupt(executionOnly)).toBe(false);
    expect(hasInterrupt(resumable)).toBe(false);
    expect(executionOnly.capabilities).not.toContain("interrupt");
  });

  test("approval 可用性按方法存在性判断", () => {
    const executionOnly = new ExecutionOnlyProvider();
    expect(typeof (executionOnly as { resolveApproval?: unknown }).resolveApproval).toBe("undefined");
  });
});

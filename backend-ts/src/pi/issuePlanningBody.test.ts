import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { listIssues, getIssue } from "../db/repositories/issues.ts";
import { readIssueDependency } from "../domain/work/issueDependency.ts";
import { materializeIssueBatch } from "./issueBatchProposal.ts";
import { withIssueBodyDependencies } from "./issuePlanningBody.ts";
import { renderIssueCreateProposalDescription } from "./issueProposalContext.ts";

const context = { projectID: "demo" };

describe("shared Issue planning body", () => {
  test("keeps manual acceptance, non-goals and additional context without duplicating the goal", () => {
    const description = renderIssueCreateProposalDescription({
      title: "手机上能打开审批会话",
      description: body("手机上能打开审批会话", "人工验收", "使用已登录 iPhone，点击审批通知，保存跳转录屏。") +
        "\n\n## 不做什么\n- 不修改通知实现，回看 {{issue:implementation}} 的 Run。",
      context_pack: {
        intent: "这是实现细节很多的内部理解，不应替换用户目标。",
        acceptance_criteria: ["打开通知对应的会话。"],
        validation: ["核对会话 ID 与通知一致。"],
        evidence: [{ source_kind: "doc", path: "docs/notifications.md", excerpt: "TOKEN=must-not-leak" }],
        open_questions: ["测试账号由用户提供。"]
      }
    }, context);
    expect(description).toContain("## 一句话目标\n手机上能打开审批会话");
    expect(description).not.toContain("内部理解");
    expect(description).not.toContain("## 自动验证");
    expect(description).toContain("保存跳转录屏");
    expect(description).toContain("核对会话 ID");
    expect(description).toContain("## 不做什么\n- 不修改通知实现");
    expect(description).toContain("docs/notifications.md");
    expect(description).toContain("测试账号由用户提供");
    expect(description).not.toContain("must-not-leak");
    expect(description.match(/打开通知对应的会话。/g)).toHaveLength(1);
  });

  test("preserves English body headings and runnable fenced validation", () => {
    const description = renderIssueCreateProposalDescription({
      description: "## Goal\nOpen the approval conversation.\n\n## Scope\n- Handle the notification.\n\n" +
        "## Acceptance criteria\n- Open the correct conversation.\n\n## Automated validation\n```sh\n## test setup\nbun test\n```\n\n## Dependencies\n- None",
      evidence: [{ source_kind: "doc", path: "docs/notifications.md" }]
    }, context);
    expect(description).toContain("## Evidence");
    expect(description).not.toContain("## 一句话目标");
    expect(description).toContain("```sh\n## test setup\nbun test\n```");
    const resolved = withIssueBodyDependencies(description, [9, 3]);
    expect(resolved).toContain("## Dependencies\n- Issue #3\n- Issue #9");
    expect(resolved).toContain("```sh\n## test setup\nbun test\n```");
  });

  test("rejects conflicting, duplicate and unresolved dependency declarations", () => {
    expect(() => withIssueBodyDependencies("## 依赖\n- Issue #5", [6])).toThrow("结构化依赖一致");
    expect(() => withIssueBodyDependencies("## 依赖\n- 无\n\n## Dependencies\n- None", [])).toThrow("多个依赖章节");
    expect(() => withIssueBodyDependencies("## 依赖\n- Issue #<id>", [6])).toThrow("没有可解析");
  });

  test("materializes a mixed batch with real bidirectional references and only the intended success edge", async () => {
    const root = await mkdtemp(join(tmpdir(), "xw-planning-batch-"));
    const db = await openDatabase({ stateDir: root });
    try {
      db.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values ('demo', 'Demo', ?, '', '')", [root]);
      const result = materializeIssueBatch(db, {
        project_id: "demo",
        batch_items: [
          { ref: "manual", title: "手机验收", depends_on_refs: ["implementation"],
            description: body("手机验收", "人工验收", "使用 iPhone 保存录屏，回看 {{issue:implementation}} 的 Run。") },
          { ref: "implementation", title: "通知跳转", depends_on_refs: [],
            description: body("通知跳转", "自动验证", "bun test notifications") +
              "\n\n## 不做什么\n- 真机验收交给 {{issue:manual}}。" }
        ]
      });
      const ids = Object.fromEntries(result.items.map((item) => [item.ref, item.id]));
      expect(getIssue(db, ids.implementation)?.description).toContain(`真机验收交给 Issue #${ids.manual}`);
      expect(getIssue(db, ids.manual)?.description).toContain(`回看 Issue #${ids.implementation} 的 Run`);
      expect(getIssue(db, ids.manual)?.description).toContain(`## 依赖\n- Issue #${ids.implementation}`);
      expect(readIssueDependency(db, ids.implementation)).toMatchObject({ ready: true, direct_dependencies: [] });
      expect(readIssueDependency(db, ids.manual)).toMatchObject({ ready: false, direct_dependencies: [{ issue_id: ids.implementation }] });
      expect(listIssues(db).every((issue) => issue.status === "triage" && !issue.description.includes("{{issue:"))).toBe(true);
      expect(db.sqlite.query("select count(*) as count from issue_runs").get()).toEqual({ count: 0 });

      const count = listIssues(db).length;
      expect(() => materializeIssueBatch(db, { project_id: "demo", batch_items: [
        { ref: "a", title: "A", description: "A", depends_on_refs: [] },
        { ref: "b", title: "B", description: "## 依赖\n- Issue #99999", depends_on_refs: ["a"] }
      ] })).toThrow("结构化依赖一致");
      expect(listIssues(db)).toHaveLength(count);
      expect(() => materializeIssueBatch(db, { project_id: "demo", batch_items: [
        { ref: "a", title: "A", description: "{{issue:missing}}", depends_on_refs: [] },
        { ref: "b", title: "B", description: "B", depends_on_refs: [] }
      ] })).toThrow("references unknown ref");
      expect(listIssues(db)).toHaveLength(count);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function body(goal: string, validationHeading: string, validation: string): string {
  return `## 一句话目标\n${goal}\n\n## 做什么\n- 完成通知跳转。\n\n## 验收标准\n- 打开通知对应的会话。\n\n## ${validationHeading}\n- ${validation}\n\n## 依赖\n- 无`;
}

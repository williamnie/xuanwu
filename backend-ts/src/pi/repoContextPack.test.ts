import { describe, expect, test } from "bun:test";
import {
  REPO_CONTEXT_PACK_NOTICE,
  createRepoContextPack,
  renderRepoContextPack
} from "./repoContextPack.ts";
import { renderRepoContextPackIssueMarkdown } from "./issueProposalContext.ts";

describe("PI repo context pack contract", () => {
  test("normalizes required fields and defaults optional arrays", () => {
    const pack = createRepoContextPack({
      intent: "  实现折叠面板功能  ",
      project: { id: "demo" },
      source: { kind: "im", channel: "feishu", message_id: "msg-1" }
    }, { now: new Date("2026-06-12T00:00:00.000Z") });

    expect(pack).toEqual({
      kind: "repo_context_pack",
      version: 1,
      intent: "实现折叠面板功能",
      project: { cwd: "", id: "demo", name: "" },
      evidence: [],
      relevant_files: [],
      proposed_changes: [],
      acceptance_criteria: [],
      validation: [],
      open_questions: [],
      confidence: "medium",
      generated_at: "2026-06-12T00:00:00.000Z",
      source: { channel: "feishu", kind: "im", message_id: "msg-1", session_key: "" }
    });
  });

  test("cleans arrays, evidence fields, and secret-like excerpts", () => {
    const pack = createRepoContextPack({
      intent: "Add panel\n",
      project: { cwd: " /tmp/demo ", id: " demo ", name: " Demo " },
      evidence: [{
        source_kind: "code",
        path: " src/components/Accordion.tsx ",
        reason: " likely owner ",
        excerpt: "TOKEN=super-secret\nexport function Accordion() {}",
        confidence: "certain" as never
      }, {
        source_kind: "code",
        path: "  ",
        reason: "  "
      }],
      relevant_files: [{
        path: " src/components/Accordion.tsx ",
        reason: " component boundary ",
        symbols: [" ", "Accordion"]
      }],
      proposed_changes: [" ", " Add controlled collapsed state "],
      acceptance_criteria: [" Panel can collapse ", ""],
      validation: [" bun test src/pi/repoContextPack.test.ts "],
      open_questions: ["  "],
      confidence: "sure" as never
    });

    expect(pack.project).toEqual({ cwd: "/tmp/demo", id: "demo", name: "Demo" });
    expect(pack.evidence).toEqual([{
      source_kind: "code",
      path: "src/components/Accordion.tsx",
      issue_id: 0,
      session_key: "",
      message_id: "",
      reason: "likely owner",
      excerpt: "[redacted sensitive line]\nexport function Accordion() {}",
      summary: "",
      confidence: "medium"
    }]);
    expect(pack.relevant_files).toEqual([{
      path: "src/components/Accordion.tsx",
      reason: "component boundary",
      symbols: ["Accordion"]
    }]);
    expect(pack.proposed_changes).toEqual(["Add controlled collapsed state"]);
    expect(pack.acceptance_criteria).toEqual(["Panel can collapse"]);
    expect(pack.validation).toEqual(["bun test src/pi/repoContextPack.test.ts"]);
    expect(pack.open_questions).toEqual([]);
    expect(pack.confidence).toBe("medium");
  });

  test("renders an IM feature request as non-binding issue context", () => {
    const pack = createRepoContextPack({
      intent: "帮我实现这个折叠面板功能",
      project: { id: "movo-web", name: "MOVO Web" },
      evidence: [{
        source_kind: "message",
        message_id: "feishu-msg-42",
        reason: "user asked for an accordion-like interaction",
        summary: "用户希望新增可展开/收起的面板。",
        confidence: "high"
      }, {
        source_kind: "code",
        path: "src/components/Accordion.tsx",
        reason: "existing component likely owns the interaction",
        excerpt: "export function Accordion() { ... }",
        confidence: "medium"
      }],
      relevant_files: [{ path: "src/components/Accordion.tsx", reason: "primary UI component", symbols: ["Accordion"] }],
      proposed_changes: ["Add collapsed state and accessible toggle affordance."],
      acceptance_criteria: ["Panel expands and collapses from the IM-described entry point."],
      validation: ["bun test src/components/Accordion.test.tsx"],
      open_questions: ["确认折叠默认态是否展开。"],
      confidence: "medium",
      source: { kind: "im", channel: "feishu", message_id: "feishu-msg-42" }
    }, { now: new Date("2026-06-12T00:00:00.000Z") });

    const markdown = renderRepoContextPack(pack);

    expect(markdown).toContain("## Supervisor repo_context_pack");
    expect(markdown).toContain(REPO_CONTEXT_PACK_NOTICE);
    expect(markdown).toContain("帮我实现这个折叠面板功能");
    expect(markdown).toContain("src/components/Accordion.tsx");
    expect(markdown).toContain("bun test src/components/Accordion.test.tsx");
    expect(markdown).toContain("executor 需要复核运行态和代码");
  });

  test("renders repo context pack into issue proposal sections", () => {
    const pack = createRepoContextPack({
      intent: "帮我实现这个折叠面板功能",
      project: { cwd: "/repo/movo-web", id: "movo-web", name: "MOVO Web" },
      evidence: [{
        source_kind: "code",
        path: "src/components/Accordion.tsx",
        reason: "existing component likely owns the UI",
        excerpt: "API_KEY=super-secret\nexport function Accordion() {}",
        confidence: "medium"
      }],
      relevant_files: [{
        path: "src/components/Accordion.tsx",
        reason: "primary component",
        symbols: ["Accordion"]
      }],
      proposed_changes: ["Add collapsed state and accessible toggle affordance."],
      acceptance_criteria: ["Panel expands and collapses from the IM-described entry point."],
      validation: ["bun test src/components/Accordion.test.tsx"],
      open_questions: ["确认折叠默认态是否展开。"],
      source: { kind: "im", channel: "feishu", message_id: "msg-42" }
    }, { now: new Date("2026-06-12T00:00:00.000Z") });

    const markdown = renderRepoContextPackIssueMarkdown(pack, {
      description: "实现折叠面板\nTOKEN=must-not-leak"
    });

    expect(markdown).toContain("## 需求理解");
    expect(markdown).toContain("## 相关证据");
    expect(markdown).toContain("## 建议改动");
    expect(markdown).toContain("## 验收标准");
    expect(markdown).toContain("## 验证建议");
    expect(markdown).toContain("## 未确认问题");
    expect(markdown).toContain(REPO_CONTEXT_PACK_NOTICE);
    expect(markdown).toContain("src/components/Accordion.tsx");
    expect(markdown).toContain("bun test src/components/Accordion.test.tsx");
    expect(markdown).not.toContain("super-secret");
    expect(markdown).not.toContain("must-not-leak");
  });
});

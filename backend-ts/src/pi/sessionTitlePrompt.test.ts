import { describe, expect, test } from "bun:test";
import { parseSessionTitle, sessionTitleDate, type SessionTitleContext } from "./sessionTitlePrompt.ts";

const context: SessionTitleContext = {
  titleDate: "0903", currentTitle: "Issue #913", projectName: "玄武", conversationContent: "修复消息重复"
};

describe("会话标题规则", () => {
  test("日期只来自 createdAt，并按上海时区处理跨日和跨年", () => {
    expect(sessionTitleDate(Date.parse("2026-09-02T15:59:59Z") / 1000)).toBe("0902");
    expect(sessionTitleDate(Date.parse("2026-09-02T16:00:00Z") / 1000)).toBe("0903");
    expect(sessionTitleDate(Date.parse("2026-12-31T16:00:00Z") / 1000)).toBe("0101");
  });

  test.each([undefined, null, 0, -1, NaN, Infinity, "2026-09-03", 1788393600000])("不猜测无效日期 %p", (value) => {
    expect(sessionTitleDate(value)).toBeNull();
  });

  test.each(["功能", "设计", "修复", "优化", "发布", "探索", "文档", "研究"])("允许类型 %s", (type) => {
    const title = `0903｜${type}｜消息重复问题`;
    expect(parseSessionTitle(JSON.stringify({ title }), context)).toBe(title);
  });

  test.each([
    '{"title":null}', '{"title":"0903｜调试｜消息重复"}', '{"title":"0902｜修复｜消息重复"}',
    '{"title":"0903|修复|消息重复"}', '{"title":"0903｜修复｜"}', '{"title":"0903｜修复｜消息重复。"}',
    '{"title":"0903｜修复｜修复消息重复"}', '{"title":"0903｜修复｜玄武消息重复"}',
    '{"title":"0903｜修复｜#913 消息重复"}', '{"title":"0903｜设计｜新功能讨论"}',
    '{"title":"0903｜修复｜消息重复✅"}', '{"title":"0903｜修复｜ 消息重复"}',
    '{"title":"0903｜修复｜消息重复","projectName":"更名"}', '```json\n{"title":null}\n```',
    JSON.stringify({ title: "0903｜修复｜消息\n重复" }), JSON.stringify({ title: `0903｜修复｜${"长".repeat(33)}` })
  ])("拒绝不符合约定的模型输出 %s", (output) => {
    expect(parseSessionTitle(output, context)).toBeNull();
  });
});

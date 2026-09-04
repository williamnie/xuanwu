import { describe, expect, test } from "bun:test";
import { parseSessionTitle, sessionTitleDate, sessionTitleSystemPrompt, type SessionTitleContext } from "./sessionTitlePrompt.ts";

const context: SessionTitleContext = {
  language: "zh-CN", timeZone: "Asia/Shanghai", titleDate: "0903", currentTitle: "Issue #913", projectName: "玄武", conversationContent: "修复消息重复"
};
const englishContext: SessionTitleContext = { ...context, language: "en-US" };

describe("会话标题规则", () => {
  test("按指定时区处理 createdAt 的跨日和跨年，不假定上海时区", () => {
    const createdAt = Date.parse("2026-09-02T16:00:00Z") / 1000;
    expect(sessionTitleDate(createdAt, "Asia/Shanghai")).toBe("0903");
    expect(sessionTitleDate(createdAt, "UTC")).toBe("0902");
    expect(sessionTitleDate(createdAt, "America/Los_Angeles")).toBe("0902");
    expect(sessionTitleDate(Date.parse("2026-12-31T16:00:00Z") / 1000, "Asia/Tokyo")).toBe("0101");
    expect(sessionTitleDate(Date.parse("2026-12-31T16:00:00Z") / 1000, "America/New_York")).toBe("1231");
  });

  test("根据创建时刻应用夏令时，不使用固定 UTC 偏移", () => {
    expect(sessionTitleDate(Date.parse("2026-03-08T04:30:00Z") / 1000, "America/New_York")).toBe("0307");
    expect(sessionTitleDate(Date.parse("2026-07-08T04:30:00Z") / 1000, "America/New_York")).toBe("0708");
  });

  test.each([
    ["UTC", "0903"], ["America/Los_Angeles", "0902"], ["Pacific/Kiritimati", "0903"]
  ])("无浏览器的后端进程读取 %s 并生成正确日期", (timeZone, expectedDate) => {
    const moduleUrl = new URL("./sessionTitlePrompt.ts", import.meta.url).href;
    const code = `import { sessionTitleTimeZone, sessionTitleDate } from ${JSON.stringify(moduleUrl)};
      const timeZone = sessionTitleTimeZone();
      console.log(JSON.stringify({timeZone, date: sessionTitleDate(Date.parse("2026-09-03T01:00:00Z") / 1000, timeZone)}));`;
    const result = Bun.spawnSync(["bun", "-e", code], { env: { ...process.env, TZ: timeZone }, timeout: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ timeZone, date: expectedDate });
  });

  test.each([null, "", "Invalid/Zone"])("时区无效时不猜测日期 %p", (timeZone) => {
    expect(sessionTitleDate(Date.parse("2026-09-03T01:00:00Z") / 1000, timeZone)).toBeNull();
  });

  test.each([undefined, null, 0, -1, NaN, Infinity, "2026-09-03", 1788393600000])("不猜测无效日期 %p", (value) => {
    expect(sessionTitleDate(value, "UTC")).toBeNull();
  });

  test.each(["功能", "设计", "修复", "优化", "发布", "探索", "文档", "研究"])("允许类型 %s", (type) => {
    const title = `0903｜${type}｜消息重复问题`;
    expect(parseSessionTitle(JSON.stringify({ title }), context)).toBe(title);
  });

  test.each(["Feature", "Design", "Fix", "Optimize", "Release", "Explore", "Docs", "Research"])("英文类型 %s 与 Prompt 一致", (type) => {
    const title = `0903｜${type}｜Duplicate messages`;
    expect(sessionTitleSystemPrompt("en-US")).toContain(`- ${type}:`);
    expect(parseSessionTitle(JSON.stringify({ title }), englishContext)).toBe(title);
    expect(parseSessionTitle(JSON.stringify({ title }), context)).toBeNull();
  });

  test("Prompt 明确使用系统语言，不根据输入语言切换", () => {
    expect(sessionTitleSystemPrompt("en-US")).toContain("even when the conversation is in Chinese");
    expect(sessionTitleSystemPrompt("zh-CN")).toContain("即使对话内容是英文");
    for (const language of ["zh-CN", "en-US"] as const) {
      expect(sessionTitleSystemPrompt(language)).toContain("timeZone");
      expect(sessionTitleSystemPrompt(language)).not.toContain("Asia/Shanghai");
      expect(sessionTitleSystemPrompt(language)).toContain("createdAt");
    }
  });

  test("英文保留空格并允许较长主题，不套用汉字长度限制", () => {
    const title = "0903｜Fix｜Android message duplication after session resume";
    expect(parseSessionTitle(JSON.stringify({ title }), englishContext)).toBe(title);
    expect(parseSessionTitle(JSON.stringify({ title: `0903｜Fix｜${"a".repeat(65)}` }), englishContext)).toBeNull();
    expect(parseSessionTitle(JSON.stringify({ title: "0903｜Design｜Designer toolbar" }), englishContext)).toBe("0903｜Design｜Designer toolbar");
  });

  test.each([
    "0903｜修复｜消息重复", "0903｜fix｜Duplicate messages", "0903｜Bug｜Duplicate messages",
    "0902｜Fix｜Duplicate messages", "0903|Fix|Duplicate messages", "0903｜Fix｜fix duplicate messages",
    "0903｜Fix｜Unknown", "0903｜Design｜New feature discussion", "0903｜Fix｜Duplicate messages.",
    "0903｜Fix｜#913 duplicate messages", "0903｜Fix｜Duplicate messages✅"
  ])("拒绝错误的英文标题 %s", (title) => {
    expect(parseSessionTitle(JSON.stringify({ title }), englishContext)).toBeNull();
  });

  test("英文同样拒绝重复项目名称、额外 JSON 字段和猜测结果", () => {
    const input = { ...englishContext, projectName: "Xuanwu" };
    expect(parseSessionTitle('{"title":"0903｜Fix｜xuanwu message duplication"}', input)).toBeNull();
    expect(parseSessionTitle('{"title":"0903｜Fix｜Duplicate messages","project":"Renamed"}', input)).toBeNull();
    expect(parseSessionTitle('{"title":null}', input)).toBeNull();
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

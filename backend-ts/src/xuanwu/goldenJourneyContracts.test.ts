import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CONTRACT_PATH = "docs/architecture/xuanwu/0003-golden-journey-contracts.md";
const contract = readFileSync(resolve(REPO_ROOT, CONTRACT_PATH), "utf8");
const JOURNEY_IDS = ["GJ-01", "GJ-02", "GJ-03", "GJ-04", "GJ-05", "GJ-06"];
const REQUIRED_SECTIONS = [
  "前置状态",
  "关键状态转移",
  "证据要求",
  "失败分支",
  "最终交付物",
  "测试夹具边界",
  "自动化验收步骤"
];

describe("Xuanwu Golden Journey canonical contract", () => {
  test("defines exactly six journeys with every required acceptance field", () => {
    const actualIDs = [...contract.matchAll(/^## (GJ-\d{2})：/gm)].map((match) => match[1]);
    expect(actualIDs).toEqual(JOURNEY_IDS);

    for (const id of JOURNEY_IDS) {
      const section = journeySection(id);
      for (const heading of REQUIRED_SECTIONS) {
        expect(section).toContain(`### ${heading}`);
      }
      expect(section).toMatch(/```bash[\s\S]*bun test backend-ts\//);
      expect(section).toMatch(/node --test frontend\//);
    }
  });

  test("keeps every automated baseline reference executable from this repository", () => {
    const references = [...contract.matchAll(/(?:^|[\s`])(backend-ts|frontend)\/[^\s`]+\.test\.(?:ts|js)/gm)]
      .map((match) => match[0].trim().replace(/^`|`$/g, ""));

    expect(references.length).toBeGreaterThanOrEqual(12);
    for (const reference of new Set(references)) {
      expect(existsSync(resolve(REPO_ROOT, reference))).toBe(true);
    }
  });

  test("locks verification, audit, source-of-truth, and migration invariants", () => {
    expect(contract).toContain("截图只能作为补充 artifact，不能作为 pass oracle");
    expect(contract).toContain("`done` 不能由 LLM 文本直接决定");
    expect(contract).toContain("当前 source of truth");
    expect(contract).toContain("不新增公开 API、schema、共享状态机、provider adapter、双写或双读");
    expect(contract).toContain("兼容窗默认不超过两个正式 release");
    expect(contract).toContain("回滚步骤");
    expect(contract).toContain("删除门禁");
  });
});

function journeySection(id: string): string {
  const start = contract.indexOf(`## ${id}：`);
  if (start < 0) throw new Error(`missing ${id}`);
  const next = contract.indexOf("\n## ", start + 1);
  return contract.slice(start, next < 0 ? contract.length : next);
}

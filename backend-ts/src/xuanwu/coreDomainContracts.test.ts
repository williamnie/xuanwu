import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  makeDomainID,
  parseDomainID
} from "./coreDomainContracts.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ADR_PATH = "docs/architecture/xuanwu/0004-core-domain-objects.md";

describe("Xuanwu core domain contracts", () => {
  test("builds stable kind-scoped IDs from authoritative legacy records", () => {
    const workID = makeDomainID("work", "issues", 634);
    const runID = makeDomainID("run", "issue_runs", "issue:634/attempt:1");

    expect(workID).toBe("xw:work:issues:634");
    expect(runID).toBe("xw:run:issue_runs:issue%3A634%2Fattempt%3A1");
    expect(parseDomainID(runID)).toEqual({
      authority: "issue_runs",
      kind: "run",
      local_id: "issue:634/attempt:1"
    });
    expect(() => makeDomainID("work", "issues", "")).toThrow("work local id is required");
  });

  test("keeps the canonical ADR, relationship diagram, legacy mapping, and migration gates", () => {
    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    for (const heading of ["Work", "Run", "Evidence", "Handoff", "Attention", "Automation"]) {
      expect(adr).toContain(`**${heading}**`);
    }
    expect(adr).toContain("```mermaid");
    expect(adr).toContain("## 8. 现有 Issue、Session、Guardian、PI 映射");
    expect(adr).toContain("**source of truth：**");
    expect(adr).toContain("**双写：无。双读：无。**");
    expect(adr).toContain("回滚开关");
    expect(adr).toContain("删除门禁");
  });
});

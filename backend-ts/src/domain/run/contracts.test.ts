import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const ADR_PATH = "docs/architecture/xuanwu/0020-run-attempt-lifecycle-contract.md";

describe("Run / Attempt lifecycle contract", () => {

  test("keeps canonical authority, migration windows, rollback, and provider mapping documented", () => {
    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    for (const heading of [
      "Run / Attempt identity",
      "状态机",
      "Codex / Claude provider refs",
      "terminal rules",
      "cost fields"
    ]) expect(adr).toContain(heading);
    expect(adr).toContain("`issue_runs` 是唯一 Run authority");
    expect(adr).toContain("`agent_sessions` 与 provider session 只提供 observation / drill-down");
    expect(adr).toContain("双写窗口为 0");
    expect(adr).toContain("P11.05");
    expect(adr).toContain("LLM 只能提出 lifecycle transition proposal");
  });
});

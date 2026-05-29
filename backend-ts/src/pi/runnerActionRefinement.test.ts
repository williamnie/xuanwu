import { describe, expect, test } from "bun:test";
import { serializeRefinement } from "./runnerActionRefinement.ts";

describe("PI runner action refinement serialization", () => {
  test("updates existing refinement blocks without dropping omitted fields", () => {
    const current = serializeRefinement("原始描述", {
      acceptance_criteria: "- 已有验收",
      problem: "已有问题",
      verification_plan: "旧验证"
    });

    const updated = serializeRefinement(current, { verification_plan: "bun test" });

    expect(updated).toContain("### Problem\n已有问题");
    expect(updated).toContain("### Acceptance criteria\n- 已有验收");
    expect(updated).toContain("### Verification plan\nbun test");
    expect(updated).not.toContain("旧验证");
  });
});

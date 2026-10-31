import { expect, test } from "bun:test";

import { validateProjectVerificationOverride } from "./policy.ts";
import { policy, group, requirement, projectOverride } from "./policyTestFixtures.ts";

export function registerPolicyOverridesCases() {
  test("rejects Project override ids that would collide after optional promotion", () => {
    const base = policy({ optional_requirements: [requirement("visual", ["browser"])] });
    const duplicateRequirement = projectOverride(base, {
      additional_required_groups: [group("extra", "all", [requirement("visual", ["browser"])])],
      promote_optional_requirement_ids: ["visual"]
    });
    expect(validateProjectVerificationOverride(duplicateRequirement, base)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("requirement visual")]
    });

    const duplicateGroup = policy({
      optional_requirements: [requirement("visual", ["browser"])],
      required_groups: [group("project.visual", "all", [requirement("test", ["test"])])]
    });
    expect(validateProjectVerificationOverride(projectOverride(duplicateGroup, {
      promote_optional_requirement_ids: ["visual"]
    }), duplicateGroup)).toMatchObject({
      ok: false,
      errors: ["project override promoted group collides with project.visual"]
    });
  });
}

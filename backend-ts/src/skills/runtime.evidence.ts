import type { SkillMetadata } from "./registry.ts";
import { arrayValue, stringList } from "../util/values.ts";
import { SkillRuntimeError } from "./runtime.model.ts";
import type { JsonObject } from "./runtime.model.ts";
import { inputEvidenceRefs, recordValue } from "./runtime.values.ts";

export function validateEvidenceBinding(skill: SkillMetadata, input: Readonly<JsonObject>, output: unknown): void {
  if (skill.kind !== "domain") return;
  const allowed = new Set(inputEvidenceRefs(input));
  const actions = arrayValue(recordValue(output).action_proposals);
  for (const [index, action] of actions.entries()) {
    const refs = stringList(recordValue(action).evidence_refs);
    if (refs.length === 0) throw new SkillRuntimeError("evidence_missing", `action_proposals[${index}] has no evidence refs`);
    const foreign = refs.find((ref) => !allowed.has(ref));
    if (foreign) throw new SkillRuntimeError("evidence_out_of_scope", `action_proposals[${index}] references uncontrolled evidence: ${foreign}`);
  }
}

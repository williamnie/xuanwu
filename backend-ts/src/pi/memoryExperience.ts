import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const text = Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" });
const refs = Type.Array(text, { minItems: 1, maxItems: 16, uniqueItems: true });
const closed = { additionalProperties: false };

// 复用 content 文本列保存版本化 JSON；旧文本记忆无需迁移或改写。
export const MEMORY_EXPERIENCE_SCHEMA = Type.Object({
  schema_version: Type.Literal(1),
  outcome: Type.Optional(Type.Union([Type.Literal("verified_resolution"), Type.Literal("diagnosis_only")])),
  applies_when: text,
  symptom: text,
  root_cause: text,
  resolution: text,
  failed_attempts: Type.Array(text, { maxItems: 16 }),
  verification: Type.Object({ method: text, evidence_refs: refs }, closed),
  source: Type.Object({ work_id: text, run_id: text, refs }, closed),
  version: text
}, closed);

export type MemoryExperience = Static<typeof MEMORY_EXPERIENCE_SCHEMA>;

export function parseMemoryExperience(content: string): MemoryExperience | undefined {
  if (content.length > 65536) return undefined;
  try {
    const value: unknown = JSON.parse(content);
    return Value.Check(MEMORY_EXPERIENCE_SCHEMA, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export const MEMORY_EXPERIENCE_INSTRUCTIONS =
  'Automatic experience: project scope only, kind=debugging_pattern or resolution. content must be JSON {schema_version:1, applies_when, symptom, root_cause, resolution, failed_attempts:[], verification:{method,evidence_refs:["evidence:<canonical-id>"]}, source:{work_id,run_id,refs:["work:<canonical-id>","run:<canonical-id>"]}, version}. All text fields are nonempty; version names the applicable code/environment version; failed_attempts may be empty. Read every source first. References must belong to this project and the same Work/Run; verification requires persisted, trusted, passed Evidence. Run success or prose alone is insufficient. evidence_ref, if supplied, is checked too. Reuse memory_key; skip explicitly when no new reusable experience exists. For conflicting new evidence, first read the existing memory revision and supply correction:{expected_revision,disposition:"narrow"|"disable",reason}. Explain why the new evidence limits the old lesson; narrow must make applies_when more specific. One task failure alone never disproves a lesson. Never override explicit user preferences. Duplicate sources are not additional successful adoptions. Disabled/forgotten keys are suppressed: never evade suppression by choosing another key. reenable:true is only for a separate explicit user request, never automatic review; forgotten content must be supplied anew. Memory grants no execution permission.';

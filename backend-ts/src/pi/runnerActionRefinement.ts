export type RefinementField =
  | "acceptance_criteria"
  | "context"
  | "needs_human_confirmation"
  | "non_goals"
  | "problem"
  | "recommendation_reasoning"
  | "recommended_profile"
  | "recommended_provider"
  | "risk_level"
  | "risks"
  | "verification_plan";

const REFINEMENT_FIELDS: Array<{ key: RefinementField; label: string }> = [
  { key: "problem", label: "Problem" },
  { key: "context", label: "Context / impacted files" },
  { key: "acceptance_criteria", label: "Acceptance criteria" },
  { key: "verification_plan", label: "Verification plan" },
  { key: "non_goals", label: "Non-goals" },
  { key: "risks", label: "Risks / questions" },
  { key: "recommended_profile", label: "Recommended profile" },
  { key: "recommended_provider", label: "Recommended provider" },
  { key: "risk_level", label: "Risk level" },
  { key: "recommendation_reasoning", label: "Reasoning / why this profile fits" },
  { key: "needs_human_confirmation", label: "Needs human confirmation" }
];

const REFINEMENT_START = "<!-- codex-refinement:start -->";
const REFINEMENT_END = "<!-- codex-refinement:end -->";

export function serializeRefinement(description: string, refinement: Partial<Record<RefinementField, string>>): string {
  const body = bodyWithoutRefinement(description);
  const fields = REFINEMENT_FIELDS.map((field) => [field, cleanString(refinement[field.key])] as const);
  if (fields.every(([, value]) => value === "")) return body;
  const lines = [REFINEMENT_START, "## Refinement"];
  for (const [field, value] of fields) lines.push("", `### ${field.label}`, value);
  lines.push("", REFINEMENT_END);
  return [body, lines.join("\n")].filter(Boolean).join("\n\n").trim();
}

function bodyWithoutRefinement(description: string): string {
  const text = cleanString(description);
  const start = text.indexOf(REFINEMENT_START);
  const end = text.indexOf(REFINEMENT_END);
  if (start < 0 || end < start) return text;
  return `${text.slice(0, start)}\n${text.slice(end + REFINEMENT_END.length)}`.trim();
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

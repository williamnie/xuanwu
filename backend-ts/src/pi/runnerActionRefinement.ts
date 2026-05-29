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
  const { body, existing } = splitRefinement(description);
  const fields = REFINEMENT_FIELDS.map((field) => [field, refinementValue(field.key, refinement, existing)] as const);
  if (fields.every(([, value]) => value === "")) return body;
  const lines = [REFINEMENT_START, "## Refinement"];
  for (const [field, value] of fields) lines.push("", `### ${field.label}`, value);
  lines.push("", REFINEMENT_END);
  return [body, lines.join("\n")].filter(Boolean).join("\n\n").trim();
}

type SplitRefinement = {
  body: string;
  existing: Partial<Record<RefinementField, string>>;
};

function splitRefinement(description: string): SplitRefinement {
  const text = cleanString(description);
  const start = text.indexOf(REFINEMENT_START);
  const end = text.indexOf(REFINEMENT_END);
  if (start < 0 || end < start) return { body: text, existing: {} };
  return {
    body: `${text.slice(0, start)}\n${text.slice(end + REFINEMENT_END.length)}`.trim(),
    existing: parseRefinementBlock(text.slice(start + REFINEMENT_START.length, end))
  };
}

function parseRefinementBlock(block: string): Partial<Record<RefinementField, string>> {
  const labels = new Map(REFINEMENT_FIELDS.map((field) => [normalizeLabel(field.label), field.key]));
  const fields: Partial<Record<RefinementField, string>> = {};
  let current: RefinementField | undefined;
  for (const line of block.split("\n")) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      current = labels.get(normalizeLabel(heading[1]));
    } else if (current) {
      fields[current] = `${fields[current] ?? ""}${line}\n`;
    }
  }
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, cleanString(value)]));
}

function refinementValue(
  field: RefinementField,
  patch: Partial<Record<RefinementField, string>>,
  existing: Partial<Record<RefinementField, string>>
): string {
  return Object.hasOwn(patch, field) ? cleanString(patch[field]) : cleanString(existing[field]);
}

function normalizeLabel(value: string): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

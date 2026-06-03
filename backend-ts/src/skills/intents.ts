export type SkillPolicy = {
  allowed?: string[];
  recommended?: string[];
  required?: string[];
};

export function normalizeSkillIntentList(value: unknown): string {
  return JSON.stringify(parseSkillIntentList(value));
}

export function parseSkillIntentList(value: unknown): string[] {
  if (Array.isArray(value)) return cleanList(value.map(String));
  const text = cleanString(value);
  if (text === "") return [];
  const parsed = parseJSON(text);
  if (Array.isArray(parsed)) return cleanList(parsed.map(String));
  return cleanList(text.split(/[\n,]/));
}

export function normalizeSkillPolicy(value: unknown): string {
  return JSON.stringify(parseSkillPolicy(value));
}

export function parseSkillPolicy(value: unknown): SkillPolicy {
  const object = objectValue(value);
  return cleanPolicy({
    allowed: parseSkillIntentList(object.allowed ?? object.allowed_skill_intents),
    recommended: parseSkillIntentList(object.recommended ?? object.recommended_skill_intents),
    required: parseSkillIntentList(object.required ?? object.required_skill_intents)
  });
}

export function skillIntentsFromPayload(payload: Record<string, unknown>): string[] {
  return cleanList([
    ...parseSkillIntentList(payload.skill_intents),
    ...parseSkillIntentList(payload.required_skill_intents),
    ...parseSkillIntentList(payload.recommended_skill_intents)
  ]);
}

export function unauthorizedSkillIntents(payload: Record<string, unknown>, allowed: string[] | undefined): string[] {
  if (!allowed) return [];
  const allowlist = new Set(parseSkillIntentList(allowed));
  return skillIntentsFromPayload(payload).filter((id) => !allowlist.has(id));
}

export function mergeSkillIntents(...values: unknown[]): string[] {
  return cleanList(values.flatMap(parseSkillIntentList));
}

function cleanPolicy(policy: SkillPolicy): SkillPolicy {
  return Object.fromEntries(Object.entries(policy).filter(([, value]) => Array.isArray(value) && value.length > 0)) as SkillPolicy;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const parsed = parseJSON(cleanString(value));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJSON(text: string): unknown {
  if (text === "") return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const id = cleanString(value).toLowerCase();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

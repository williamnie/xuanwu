export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueCleanStrings(value);
  if (typeof value !== "string") return [];
  return uniqueCleanStrings(value.split(/[;,]/));
}

export function uniqueCleanStrings(values: unknown[]): string[] {
  return [...new Set(values.map(cleanString).filter((item) => item !== ""))];
}

export function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

export function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = cleanString(value);
    if (text !== "") return text;
  }
  return "";
}

export function requiredString(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

export function cleanString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const parsed = Number(cleanString(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

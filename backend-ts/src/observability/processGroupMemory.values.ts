

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

export function positiveBytes(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function clonePublicSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function highestMemorySeverity(values: string[]): string {
  return values.reduce((highest, value) => severityRank(value) > severityRank(highest) ? value : highest, "high");
}

export function severityRank(value: string): number {
  return value === "urgent" ? 2 : value === "high" ? 1 : 0;
}

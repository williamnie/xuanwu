export type McpPolicy = {
  allowed?: string[];
  recommended?: string[];
  required?: string[];
};

export function normalizeMcpCapabilityList(value: unknown): string {
  return JSON.stringify(parseMcpCapabilityList(value));
}

export function parseMcpCapabilityList(value: unknown): string[] {
  if (Array.isArray(value)) return cleanList(value.map(String));
  const text = cleanString(value);
  if (text === "") return [];
  const parsed = parseJSON(text);
  if (Array.isArray(parsed)) return cleanList(parsed.map(String));
  return cleanList(text.split(/[\n,]/));
}

export function normalizeMcpPolicy(value: unknown): string {
  return JSON.stringify(parseMcpPolicy(value));
}

export function parseMcpPolicy(value: unknown): McpPolicy {
  const object = objectValue(value);
  return cleanPolicy({
    allowed: parseMcpCapabilityList(object.allowed ?? object.allowed_mcp_capabilities),
    recommended: parseMcpCapabilityList(object.recommended ?? object.recommended_mcp_capabilities),
    required: parseMcpCapabilityList(object.required ?? object.required_mcp_capabilities)
  });
}

export function mcpCapabilitiesFromPayload(payload: Record<string, unknown>): string[] {
  return cleanList([
    ...parseMcpCapabilityList(payload.capability_id),
    ...parseMcpCapabilityList(payload.capability_ids),
    ...parseMcpCapabilityList(payload.required_mcp_capabilities),
    ...parseMcpCapabilityList(payload.recommended_mcp_capabilities)
  ]);
}

function cleanPolicy(policy: McpPolicy): McpPolicy {
  return Object.fromEntries(Object.entries(policy).filter(([, value]) => Array.isArray(value) && value.length > 0)) as McpPolicy;
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

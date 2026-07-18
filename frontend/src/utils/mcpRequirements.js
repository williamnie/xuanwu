export function issueMcpRequirementSummary(issue = {}) {
  const apiSummary = objectValue(issue.mcp_requirements);
  return {
    diagnostics: Array.isArray(apiSummary.diagnostics) ? apiSummary.diagnostics : [],
    projectAllowed: stringList(apiSummary.project_allowed ?? apiSummary.projectAllowed),
    recommended: stringList(apiSummary.recommended ?? issue.recommended_mcp_capabilities),
    required: stringList(apiSummary.required ?? issue.required_mcp_capabilities),
  };
}

export function hasMcpRequirements(summary) {
  return Boolean(
    summary?.required?.length ||
    summary?.recommended?.length ||
    summary?.projectAllowed?.length ||
    summary?.diagnostics?.length
  );
}

export function mcpRequirementStatus(summary) {
  if (!hasMcpRequirements(summary)) return '未声明 MCP requirements';
  if (summary.diagnostics?.length) return `${summary.diagnostics.length} 个 capability 需要诊断`;
  return 'MCP requirements 已登记';
}

function stringList(value) {
  if (Array.isArray(value)) return uniqueClean(value.map(String));
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return uniqueClean(parsed.map(String));
  } catch {
    // Non-JSON strings fall back to the existing newline/comma parser below.
  }
  return uniqueClean(text.split(/[\n,]/));
}

function uniqueClean(values) {
  const seen = new Set();
  const output = [];
  values.forEach(value => {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) return;
    seen.add(item);
    output.push(item);
  });
  return output;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

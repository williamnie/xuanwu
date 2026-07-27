const DEFAULT_PROFILE_ID = '';
const DEFAULT_PROVIDER = 'codex';

export function emptyAgentProfileForm() {
  return {
    id: '',
    name: '',
    provider: DEFAULT_PROVIDER,
    model: 'codex-default',
    reasoning_effort: '',
    approval_policy: '',
    sandbox: '',
    service_tier: '',
    default_instructions: '',
    skill_intents: '',
    plugin_intents: '',
  };
}

export function normalizeAgentProfileForm(profile = {}) {
  return {
    ...emptyAgentProfileForm(),
    ...profile,
    provider: profile.provider || DEFAULT_PROVIDER,
    model: profile.model || 'codex-default',
    skill_intents: normalizeIntentText(profile.skill_intents),
    plugin_intents: normalizeIntentText(profile.plugin_intents),
  };
}

export function agentProfilePayload(form) {
  const normalized = normalizeAgentProfileForm(form);
  return {
    ...normalized,
    id: profileIDFromName(normalized.id || normalized.name),
    name: normalized.name.trim(),
    default_instructions: normalized.default_instructions.trim(),
    skill_intents: JSON.stringify(parseIntentText(normalized.skill_intents)),
    plugin_intents: JSON.stringify(parseIntentText(normalized.plugin_intents)),
  };
}

export function profileIDFromName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent-profile';
}

export function parseIntentText(value) {
  if (Array.isArray(value)) return cleanIntents(value);
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return cleanIntents(parsed);
  } catch {
    // fall through to comma/newline split
  }
  return cleanIntents(text.split(/[\n,]/));
}

export function normalizeIntentText(value) {
  return parseIntentText(value).join(', ');
}

export function summarizeAgentProfile(profile) {
  if (!profile?.id) return '未配置，沿用项目执行参数';
  const parts = [profile.name || profile.id, profile.provider || DEFAULT_PROVIDER];
  if (profile.model) parts.push(profile.model);
  if (profile.reasoning_effort) parts.push(`effort:${profile.reasoning_effort}`);
  if (profile.service_tier) parts.push(`speed:${profile.service_tier}`);
  return parts.join(' · ');
}

export function issueRunProfileLabel(run, project, profiles = []) {
  const hasRun = Boolean(run && (run.id || run.selection_reason || run.agent_profile_id !== undefined));
  const id = run?.agent_profile_id || (!hasRun ? project?.default_agent_profile_id : DEFAULT_PROFILE_ID);
  if (!id) return '未配置';
  const profile = project?.default_agent_profile;
  if (profile?.id === id && profile?.name) return `${profile.name} (${id})`;
  const listedProfile = Array.isArray(profiles) ? profiles.find(item => item?.id === id) : null;
  if (listedProfile?.name) return `${listedProfile.name} (${id})`;
  return id;
}

export function runSelectionReasonLabel(reason) {
  switch (String(reason || '').trim()) {
    case 'issue_override':
      return 'Issue override';
    case 'project_default':
      return 'Project default';
    case 'provider_default':
      return 'Provider default';
    default:
      return reason || '未记录';
  }
}

export function runCapabilitySummary(run) {
  if (Array.isArray(run?.capabilities) && run.capabilities.length > 0) {
    return run.capabilities.join(', ');
  }
  const summary = String(run?.capability_summary || '').trim();
  if (!summary) return '未记录';
  return summary.split(',').map(item => item.trim()).filter(Boolean).join(', ');
}

function cleanIntents(values) {
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

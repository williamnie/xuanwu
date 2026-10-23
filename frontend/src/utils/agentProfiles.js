import { profileExecutionPolicy } from './executionPolicy.js';
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
    plugin_intents: '[]',
    execution_policy: null,
  };
}

export function normalizeAgentProfileForm(profile = {}) {
  const provider = profile.provider || DEFAULT_PROVIDER;
  const model = String(profile.model || '').trim();
  return {
    ...emptyAgentProfileForm(),
    ...profile,
    provider,
    model: provider === DEFAULT_PROVIDER ? (model || 'codex-default') : (model === 'codex-default' ? '' : model),
    execution_policy: profileExecutionPolicy(profile),
    skill_intents: normalizeIntentText(profile.skill_intents),
    plugin_intents: Object.hasOwn(profile, 'plugin_intents') ? profile.plugin_intents : '[]',
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
    plugin_intents: normalized.plugin_intents,
    execution_policy: normalized.execution_policy || {},
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

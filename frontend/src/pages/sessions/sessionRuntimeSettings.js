import { defaultMessageSettings } from './sessionOptions.js';

export function sessionRuntimeSettings(session = null) {
  const rawRef = parseRawRef(session?.raw_ref);
  const runtime = recordValue(session?.runtime_settings);
  return compactSettings({
    model: normalizeModel(firstNonEmpty(runtime.model, session?.model, rawRef.model, rawRef.model_id)),
    reasoningEffort: firstNonEmpty(
      runtime.reasoning_effort, runtime.reasoningEffort,
      session?.reasoning_effort, session?.reasoningEffort, session?.effort,
      rawRef.reasoning_effort, rawRef.reasoningEffort, rawRef.effort,
    ),
    serviceTier: firstNonEmpty(
      runtime.service_tier, runtime.serviceTier,
      session?.service_tier, session?.serviceTier,
      rawRef.service_tier, rawRef.serviceTier,
    ),
    approvalPolicy: firstNonEmpty(
      runtime.approval_policy, runtime.approvalPolicy,
      session?.approval_policy, session?.approvalPolicy,
      rawRef.approval_policy, rawRef.approvalPolicy,
    ),
    sandbox: firstNonEmpty(runtime.sandbox, session?.sandbox, rawRef.sandbox),
  });
}

export function messageSettingsForSession(session, project) {
  return messageSettingsForRuntimeKey(sessionRuntimeSettingsKey(session), project);
}

export function messageSettingsForRuntimeKey(runtimeKey, project) {
  return {
    ...defaultMessageSettings(project),
    ...settingsFromRuntimeKey(runtimeKey),
  };
}

export function sessionRuntimeSettingsKey(session) {
  return JSON.stringify(sessionRuntimeSettings(session));
}

function parseRawRef(value) {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return {};
  }
}

function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactSettings(settings) {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeModel(value) {
  return value === 'codex-default' ? '' : value;
}

function settingsFromRuntimeKey(value) {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return {};
  }
}

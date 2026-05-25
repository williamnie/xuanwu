const DEFAULT_PROVIDER = 'codex';

export function latestIssueRun(issue) {
  return issue?.latest_run || null;
}

export function providerLabel(provider) {
  switch (String(provider || DEFAULT_PROVIDER).toLowerCase()) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'opencode':
      return 'opencode';
    case 'kimicode':
      return 'kimicode';
    default:
      return provider || 'Unknown';
  }
}

export function issueRunSessionId(issue, run) {
  return firstNonEmpty(run?.provider_session_id, run?.codex_thread_id, issue?.codex_thread_id);
}

export function issueRunTurnId(issue, run) {
  return firstNonEmpty(run?.provider_turn_id, run?.codex_turn_id, issue?.codex_turn_id);
}

export function issueRunSessionRef(issue, run) {
  const sessionId = issueRunSessionId(issue, run);
  if (!sessionId) return '';
  return providerSessionKey(run?.provider || DEFAULT_PROVIDER, sessionId);
}

export function issueFailureReason(issue, run, maxLength = 180) {
  return summarize(firstNonEmpty(issue?.error, run?.error, run?.exit_reason), maxLength);
}

export function issueRunExitText(run, maxLength = 120) {
  return summarize(firstNonEmpty(run?.error, run?.exit_reason), maxLength);
}

export function shortId(value, prefixLength = 8, suffixLength = 4) {
  const text = String(value || '').trim();
  if (!text || text.length <= prefixLength + suffixLength + 1) return text;
  return `${text.slice(0, prefixLength)}…${text.slice(-suffixLength)}`;
}

export function summarize(value, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function providerSessionKey(provider, sessionId) {
  const normalizedProvider = String(provider || DEFAULT_PROVIDER).trim().toLowerCase();
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return '';
  if (normalizedSessionId.startsWith(`${normalizedProvider}:`)) return normalizedSessionId;
  return `${normalizedProvider}:${normalizedSessionId}`;
}

function firstNonEmpty(...values) {
  return values.find(value => String(value || '').trim()) || '';
}

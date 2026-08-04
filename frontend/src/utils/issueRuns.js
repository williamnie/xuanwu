const DEFAULT_PROVIDER = 'codex';
// P6：静态 SESSION_CAPABLE_PROVIDERS 不再作为 authority——由 catalog capabilities.sessions 派生（见 sessionCapableFromCatalog）。
const SESSION_CAPABLE_PROVIDERS_FALLBACK = new Set(['codex', 'claude']);

/**
 * P6：从 catalog 派生 session-capable Provider 集合（唯一权威，替代静态 SESSION_CAPABLE_PROVIDERS）。
 * catalog 条目未声明 sessions capability 的 Provider（execution-only）不进入集合。
 */
export function sessionCapableFromCatalog(catalog) {
  if (!Array.isArray(catalog)) return new Set();
  return new Set(
    catalog
      .filter((entry) => entry?.capabilities?.sessions && entry.state === 'ready')
      .map((entry) => entry.id)
  );
}

export function isSessionCapableProvider(provider, catalog) {
  const id = String(provider || DEFAULT_PROVIDER).trim().toLowerCase();
  if (Array.isArray(catalog)) return sessionCapableFromCatalog(catalog).has(id);
  return SESSION_CAPABLE_PROVIDERS_FALLBACK.has(id);
}

export function latestIssueRun(issue) {
  return issue?.latest_run || null;
}

/**
 * P6：单一 label helper——catalog 优先，静态回退（旧 projection 兼容窗口）。
 */
export function providerLabel(provider, catalog) {
  const id = String(provider || DEFAULT_PROVIDER);
  if (Array.isArray(catalog)) {
    const entry = catalog.find((item) => item?.id === id);
    if (entry?.label) return entry.label;
  }
  switch (String(provider || DEFAULT_PROVIDER).toLowerCase()) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
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
  if (!providerSupportsSessionOpen(run?.provider || DEFAULT_PROVIDER)) return '';
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

export function issueRunMetadata(run) {
  return parseMetadata(run?.runtime_metadata_json);
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

function providerSupportsSessionOpen(provider) {
  return SESSION_CAPABLE_PROVIDERS.has(String(provider || DEFAULT_PROVIDER).trim().toLowerCase());
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstNonEmpty(...values) {
  return values.find(value => String(value || '').trim()) || '';
}

export function codexAppThreadId(session) {
  const provider = normalizeText(session?.provider || 'codex').toLowerCase();
  if (provider !== 'codex') return '';
  return firstNonEmpty(
    session?.provider_session_id,
    session?.sessionId,
    stripProviderPrefix(session?.id),
  );
}

export function codexAppThreadUrl(session) {
  const threadId = codexAppThreadId(session);
  return threadId ? `codex://threads/${encodeURIComponent(threadId)}` : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function stripProviderPrefix(value) {
  const text = normalizeText(value);
  const index = text.indexOf(':');
  return index >= 0 ? text.slice(index + 1) : text;
}

function normalizeText(value) {
  return String(value || '').trim();
}

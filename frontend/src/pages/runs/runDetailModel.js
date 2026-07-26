export const RUN_EVENT_PAGE_SIZE = 100;
export const RUN_EVENT_SCAN_LIMIT = 500;

export function selectedRunAttempt(run, attemptId = '') {
  const attempts = Array.isArray(run?.attempts) ? run.attempts : [];
  return attempts.find(attempt => attempt.id === attemptId) || attempts.at(-1) || null;
}

export function runEventInitialBeforeId(run, attempt = null) {
  const ended = text(attempt?.ended_at) || (!attempt ? text(run?.ended_at) : '');
  if (!ended) return '';
  const summaries = Array.isArray(run?.progress?.phase_summary) ? run.progress.phase_summary : [];
  const scoped = attempt?.id ? summaries.filter(item => item.attempt_id === attempt.id) : summaries;
  const lastEventId = Math.max(0, ...scoped.map(item => positiveInteger(item?.last_event_id)));
  const fallback = positiveInteger(run?.progress?.source_event_range?.last_id);
  const anchor = lastEventId || fallback;
  return anchor ? String(anchor + 1) : '';
}

export function eventsWithinAttempt(events = [], attempt = null, run = {}) {
  const startedAt = timestamp(attempt?.started_at || run?.started_at);
  const endedAt = timestamp(attempt?.ended_at || (!attempt ? run?.ended_at : '')) || Number.POSITIVE_INFINITY;
  return events.filter(event => {
    const occurredAt = timestamp(event?.created_at);
    return occurredAt >= startedAt && occurredAt <= endedAt;
  });
}

export function mergeRunEventPages(current = [], incoming = [], maximum = RUN_EVENT_SCAN_LIMIT) {
  const merged = new Map();
  [...current, ...incoming].forEach(event => {
    const id = positiveInteger(event?.id);
    if (id) merged.set(id, event);
  });
  const ordered = [...merged.values()].sort((left, right) => positiveInteger(left.id) - positiveInteger(right.id));
  return ordered.length > maximum ? ordered.slice(-maximum) : ordered;
}

export function eventPageCursor(events = []) {
  const ids = events.map(event => positiveInteger(event?.id)).filter(Boolean);
  return ids.length ? String(Math.min(...ids)) : '';
}

export function runLogSummary(event, maximum = 280) {
  const payload = jsonObject(event?.payload);
  const runEvent = object(payload.run_event);
  const source = object(runEvent.source);
  const value = [
    payload.text,
    payload.error,
    payload.status,
    payload.command,
    payload.raw_method,
    payload.type,
    source.method,
    event?.type,
  ].map(text).find(Boolean) || 'Raw event';
  return truncate(value.replace(/\s+/g, ' '), maximum);
}

export function runCostView(cost) {
  const usage = object(cost?.usage);
  const money = object(cost?.money);
  return {
    cachedInput: tokenValue(usage.cached_input_tokens),
    completeness: text(usage.completeness) || 'unavailable',
    input: tokenValue(usage.input_tokens),
    money: moneyValue(money),
    output: tokenValue(usage.output_tokens),
    reasoning: tokenValue(usage.reasoning_output_tokens),
    total: tokenValue(usage.total_tokens),
  };
}

function tokenValue(value) {
  return Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat('en-US').format(value) : '—';
}

function moneyValue(money) {
  const amountMicros = money.amount_micros;
  const currency = text(money.currency);
  if (!Number.isFinite(amountMicros) || !currency) return 'Unavailable';
  return `${currency} ${(amountMicros / 1_000_000).toFixed(6)}`;
}

function truncate(value, maximum) {
  return value.length > maximum ? `${value.slice(0, Math.max(0, maximum - 1))}…` : value;
}

function jsonObject(value) {
  if (typeof value !== 'string') return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function timestamp(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

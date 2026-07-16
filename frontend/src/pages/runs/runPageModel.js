const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export function resolveRunsPage(page) {
  return page === 'sessions' ? 'runs' : page;
}

export function mergeRunPages(current, incoming) {
  const byId = new Map(current.map(run => [run.id, run]));
  incoming.forEach(run => byId.set(run.id, run));
  return [...byId.values()];
}

export function runIssueId(run) {
  const match = /^xw:work:issues:([1-9]\d*)$/.exec(String(run?.work_id || ''));
  return match ? Number(match[1]) : null;
}

export function runProviderSessionRef(run) {
  const attempts = Array.isArray(run?.attempts) ? [...run.attempts].reverse() : [];
  for (const attempt of attempts) {
    const observationRef = text(attempt?.provider_ref?.observation_ref) || text(attempt?.agent_session_key);
    if (observationRef) return observationRef;
    const provider = text(attempt?.provider_ref?.provider) || text(run?.provider);
    const sessionRef = text(attempt?.provider_ref?.session_ref);
    if (provider && sessionRef) return `${provider}:${sessionRef}`;
  }
  return '';
}

export function runAvailableActions(run) {
  const latestAttempt = Array.isArray(run?.attempts) ? run.attempts.at(-1) : null;
  const active = run?.status === 'running' || run?.status === 'recovering';
  return {
    interrupt: active && latestAttempt?.status === 'running' && Boolean(runProviderSessionRef(run)),
    resume: active && latestAttempt?.status === 'succeeded' && Boolean(runProviderSessionRef(run)),
    retry: TERMINAL_RUN_STATUSES.has(run?.status) || (active && latestAttempt?.status === 'interrupted'),
  };
}

export function buildRunControlPayload(run, action, {
  eventId,
  occurredAt = new Date().toISOString(),
  prompt = '',
} = {}) {
  const latestAttempt = Array.isArray(run?.attempts) ? run.attempts.at(-1) : null;
  const payload = {
    audit: {
      actor: { id: 'frontend:user', kind: 'user' },
      correlation_id: `runs-ui:${run?.id || 'unknown'}`,
      event_id: text(eventId),
      occurred_at: occurredAt,
      reason: `Runs compatibility view requested ${action}`,
    },
    expected_revision: Number(run?.revision || 0),
  };
  if (action === 'interrupt' || action === 'resume') {
    payload.expected_attempt_revision = Number(latestAttempt?.revision || 0);
  }
  if (action === 'resume') payload.prompt = text(prompt);
  return payload;
}

export function runStatusLabel(status) {
  return ({
    cancelled: 'Cancelled',
    failed: 'Failed',
    recovering: 'Recovering',
    running: 'Running',
    succeeded: 'Succeeded',
  })[status] || 'Unknown';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

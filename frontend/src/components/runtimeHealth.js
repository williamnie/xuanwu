export function buildRuntimeHealth({ status, error = '', backendOnline = false }) {
  const loading = !status && !error;
  const apiOk = status ? Boolean(status.service?.alive) : backendOnline && !error;
  const dbOk = Boolean(status?.db?.ok);
  const codexOk = Boolean(status?.codex?.command_ok);
  const issues = [
    !apiOk && !loading ? `API ${error || 'offline'}` : '',
    status && !dbOk ? `DB ${status.db?.error || 'error'}` : '',
    status && !codexOk ? `Codex ${status.codex?.command_error || 'command missing'}` : '',
  ].filter(Boolean);

  if (loading) {
    return {
      ok: true,
      title: 'Runtime status 读取中',
      reason: '',
      items: buildHealthItems({ status, error, apiOk, dbOk, codexOk }),
    };
  }

  const ok = issues.length === 0;
  return {
    ok,
    title: ok ? 'Runtime healthy' : 'Runtime 需要关注',
    reason: issues[0] || '等待 runtime status',
    items: buildHealthItems({ status, error, apiOk, dbOk, codexOk }),
  };
}

function buildHealthItems({ status, error, apiOk, dbOk, codexOk }) {
  return [
    { label: 'API', value: apiValue(status, error, apiOk), ok: Boolean(!error && (apiOk || !status)) },
    { label: 'Codex command', value: commandValue(status), ok: Boolean(status && codexOk) },
    { label: 'DB', value: dbOk ? 'ok' : dbValue(status), ok: Boolean(status && dbOk) },
    { label: 'Running', value: runnerValue(status), ok: true },
    { label: 'Auth', value: authValue(status), ok: true },
  ];
}

function apiValue(status, error, apiOk) {
  if (error) return 'down';
  if (!status) return 'checking';
  return apiOk ? 'online' : 'down';
}

function commandValue(status) {
  if (!status) return 'checking';
  if (status.codex?.command_ok) return status.codex?.command || status.config?.codex_cmd || 'ok';
  return status.codex?.command_error || 'missing';
}

function dbValue(status) {
  if (!status) return 'checking';
  return status.db?.error || 'error';
}

function runnerValue(status) {
  const runner = status?.runner;
  if (!runner) return 'loops 0 · issues 0/0 · sessions 0';
  const issueText = `${runner.running_issues || 0}/${runner.in_progress_issues || 0}`;
  return `loops ${runner.running_loops || 0} · issues ${issueText} · sessions ${runner.running_sessions || 0}`;
}

function authValue(status) {
  if (!status) return 'checking';
  return status.config?.auth_enabled ? 'enabled' : 'disabled';
}

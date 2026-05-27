const AUTH_HEADER_PATTERN = /Authorization:\s*[^\r\n]+/gi;
const BEARER_PATTERN = /Bearer\s+[^\s,;]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)[^\s,;]+/gi;

export function formatRuntimeLogsSummary(summary) {
  const lines = [
    'Runtime logs summary',
    `generated_at=${summary?.generated_at || 'unknown'}`,
    `line_limit=${summary?.line_limit || 0}`,
  ];
  lines.push(...formatLogFiles(summary?.logs || []));
  lines.push(...formatImportantLines('recent_errors', summary?.recent_errors || []));
  lines.push(...formatImportantLines('recent_warnings', summary?.recent_warnings || []));
  return redactRuntimeText(lines.join('\n'));
}

export function runtimeLogStats(summary) {
  const logs = summary?.logs || [];
  return {
    errors: (summary?.recent_errors || []).length,
    warnings: (summary?.recent_warnings || []).length,
    missing: logs.filter(log => !log.available).length,
    paths: logs.map(log => log.path).filter(Boolean),
  };
}

export function redactRuntimeText(text) {
  return String(text || '')
    .replace(AUTH_HEADER_PATTERN, 'Authorization: [redacted]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(/.*(?:auth_token|auth-token|codex_runner_auth_token).*$/gim, '[redacted sensitive log line]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1[redacted]');
}

function formatLogFiles(logs) {
  if (logs.length === 0) {
    return ['logs=none'];
  }
  return logs.map(log => [
    `log.${log.source || 'runtime'}.path=${log.path || 'unknown'}`,
    `log.${log.source || 'runtime'}.available=${Boolean(log.available)}`,
    log.error ? `log.${log.source || 'runtime'}.error=${log.error}` : '',
  ].filter(Boolean).join('\n'));
}

function formatImportantLines(title, lines) {
  if (lines.length === 0) {
    return [`${title}=none`];
  }
  return [title, ...lines.map(line => {
    const stamp = line.time ? `${line.time} ` : '';
    return `- [${line.source || 'runtime'}] ${stamp}${line.level || 'info'} ${line.text || ''}`;
  })];
}

export const CODEX_BACKEND_CHOICES = Object.freeze([
  {
    description: '独立拉起 CLI app-server，适合稳定的后台自动执行。',
    id: 'cli',
    label: 'Codex CLI',
  },
  {
    description: '使用 Codex App bundled app-server，适合需要 App / Chrome 集成的任务。',
    id: 'app',
    label: 'Codex App',
  },
]);

export function codexBackendChoices(settings = {}) {
  const selected = settings?.codex_server_mode === 'app' ? 'app' : 'cli';
  return CODEX_BACKEND_CHOICES.map(choice => ({
    ...choice,
    active: choice.id === selected,
    status: choice.id === 'app'
      ? codexAppBackendStatus(settings?.codex_app_status)
      : codexCliBackendStatus(settings?.codex_cli_status),
  }));
}

export function codexBackendUpdatePayload(mode) {
  if (mode !== 'cli' && mode !== 'app') throw new TypeError('Codex backend must be cli or app');
  return { codex_server_mode: mode };
}

function codexCliBackendStatus(status) {
  if (!status) return { detail: '尚未检测', ready: false };
  return {
    detail: [status.version, status.path || status.error].filter(Boolean).join(' · ') || status.command || '尚未检测',
    ready: status.available === true,
  };
}

function codexAppBackendStatus(status) {
  if (!status) return { detail: '尚未检测', integrationReady: false, ready: false, running: false };
  const integration = status.native_host_configured ? 'App 集成已配置' : 'App 集成未配置';
  const running = status.running ? 'App 运行中' : '未检测到 App 运行态';
  return {
    detail: [status.version, status.path, integration, running].filter(Boolean).join(' · '),
    integrationReady: status.native_host_configured === true,
    ready: status.installed === true,
    running: status.running === true,
  };
}

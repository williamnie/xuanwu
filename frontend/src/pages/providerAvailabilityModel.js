export function providerAuthenticationText(provider = {}) {
  if (provider.id !== 'claude') {
    return provider.secrets?.api_key?.configured ? 'API key 已配置' : '未配置 API key';
  }
  switch (provider.auth_mode) {
    case 'local-cli':
      return provider.local_cli?.logged_in
        ? `本地 Claude CLI 已登录${provider.local_cli.auth_method ? ` · ${provider.local_cli.auth_method}` : ''}`
        : '本地 Claude CLI 未登录';
    case 'platform-profile':
      return provider.auth_configured
        ? `Anthropic profile · ${provider.platform_profile?.profile || 'default'}`
        : `Anthropic profile 不可用 · ${provider.platform_profile?.profile || 'default'}`;
    case 'environment':
      return provider.auth_configured ? environmentAuthLabel(provider.auth_source) : '环境认证未配置';
    default:
      return provider.auth_configured ? '认证已配置' : '认证未配置';
  }
}

export function providerRuntimeText(provider = {}) {
  if (provider.mode === 'sdk') {
    const version = provider.sdk?.version ? ` ${provider.sdk.version}` : '';
    return `Claude Agent SDK${version}`;
  }
  if (provider.mode === 'cli-fallback') return provider.cli?.version || 'Claude CLI fallback';
  return provider.cli?.version || provider.cli?.command || '未检测';
}

function environmentAuthLabel(source) {
  if (source === 'api_key') return 'API key 已配置';
  if (source === 'auth_token') return 'Gateway auth token 已配置';
  if (source === 'claude_oauth_token') return 'OAuth token 已配置';
  return '环境认证已配置';
}

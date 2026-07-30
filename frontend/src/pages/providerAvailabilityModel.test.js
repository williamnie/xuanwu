import { describe, expect, test } from 'bun:test';
import { providerAuthenticationText, providerRuntimeText } from './providerAvailabilityModel.js';

describe('provider availability presentation', () => {
  test('shows local Claude CLI login without credentials', () => {
    expect(providerAuthenticationText({
      id: 'claude',
      auth_mode: 'local-cli',
      local_cli: { auth_method: 'claude.ai', logged_in: true }
    })).toBe('本地 Claude CLI 已登录 · claude.ai');
  });

  test('shows the safe Anthropic profile name', () => {
    expect(providerAuthenticationText({
      id: 'claude',
      auth_configured: true,
      auth_mode: 'platform-profile',
      platform_profile: { profile: 'runner' }
    })).toBe('Anthropic profile · runner');
  });

  test('shows SDK and CLI runtime modes separately', () => {
    expect(providerRuntimeText({ mode: 'sdk', sdk: { version: '0.3.152' } })).toBe('Claude Agent SDK 0.3.152');
    expect(providerRuntimeText({ mode: 'cli-fallback' })).toBe('Claude CLI fallback');
  });
});

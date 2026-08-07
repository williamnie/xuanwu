import { describe, expect, test } from 'bun:test';
import { availableTranslationKeys, normalizeLanguage, translate } from './translations.js';

describe('frontend i18n resources', () => {
  test('normalizes supported locale variants', () => {
    expect(normalizeLanguage('en-GB')).toBe('en-US');
    expect(normalizeLanguage('zh-Hans')).toBe('zh-CN');
  });

  test('translates navigation and interpolated Work labels', () => {
    expect(translate('zh-CN', 'nav.commandCenter')).toBe('Dashboard');
    expect(translate('en-US', 'nav.commandCenter')).toBe('Dashboard');
    expect(translate('zh-CN', 'work.runsCount', { count: 3 })).toBe('3 次运行');
  });

  test('keeps Chinese and English resource keys in parity', () => {
    expect(availableTranslationKeys('en-US')).toEqual(availableTranslationKeys('zh-CN'));
  });
});

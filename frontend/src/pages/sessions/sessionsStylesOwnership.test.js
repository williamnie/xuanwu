import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const sessionsCss = readFileSync(new URL('./Sessions.css', import.meta.url), 'utf8');
const clientCss = readFileSync(new URL('./SessionsClient.css', import.meta.url), 'utf8');
const composerCss = readFileSync(new URL('./SessionComposer.css', import.meta.url), 'utf8');
const foundationCss = readFileSync(new URL('../../GeekWorkbench.css', import.meta.url), 'utf8');
const globalCss = [
  readFileSync(new URL('../../index.css', import.meta.url), 'utf8'),
  readFileSync(new URL('../../GeekWorkbenchPages.css', import.meta.url), 'utf8'),
].join('\n');
const runtimeSource = [
  readFileSync(new URL('../Sessions.jsx', import.meta.url), 'utf8'),
  ...readdirSync(new URL('.', import.meta.url))
    .filter((name) => name.endsWith('.jsx'))
    .map((name) => readFileSync(new URL(name, import.meta.url), 'utf8')),
].join('\n');

function ruleCount(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{`, 'g'))].length;
}

test('Sessions design tokens have one global source of truth and local consumers', () => {
  for (const token of [
    '--sessions-transcript-max-width',
    '--sessions-message-max-width',
    '--sessions-composer-max-width',
    '--sessions-page-gutter',
    '--sessions-composer-radius',
  ]) {
    assert.equal((foundationCss.match(new RegExp(`${token}:`, 'g')) || []).length, 1, token);
  }

  assert.match(sessionsCss, /var\(--sessions-transcript-max-width\)/);
  assert.match(sessionsCss, /var\(--sessions-message-max-width\)/);
  assert.match(clientCss, /var\(--sessions-page-gutter\)/);
  assert.match(composerCss, /var\(--sessions-composer-max-width\)/);
  assert.match(composerCss, /var\(--sessions-composer-radius\)/);
});

test('Sessions primitives, page composition, and composer internals have distinct owners', () => {
  assert.equal(ruleCount(sessionsCss, '.session-item-row'), 1);
  assert.equal(ruleCount(sessionsCss, '.session-list-loading'), 1);
  assert.equal(ruleCount(sessionsCss, '.chat-bubble-container.user'), 1);
  assert.equal(ruleCount(clientCss, '.client-chat-composer-section .session-composer'), 0);
  assert.equal(ruleCount(composerCss, '.client-chat-composer-section .session-composer'), 1);
  assert.equal(ruleCount(clientCss, '.composer-circle-submit'), 1);
  assert.doesNotMatch(composerCss, /\.composer-circle-submit/);
  assert.doesNotMatch(clientCss, /prompt-editor-(?:shell|content)/);
  assert.match(composerCss, /\.new-session-composer-wrapper \.prompt-editor-shell\.composer/);
  assert.doesNotMatch(globalCss, /\.(?:sessions-client|client-chat|new-session|session-list-filter|session-info)/);
});

test('removed legacy selectors have neither runtime references nor CSS rules', () => {
  const removed = [
    'sessions-page',
    'sessions-shell',
    'sessions-sidebar',
    'sessions-client-sidebar',
    'session-list-filter-tabs',
    'session-list-filter-tab',
    'project-group-drag-handle',
    'session-error',
    'sidebar-mac-header',
    'mac-dots',
    'mac-dot',
    'sidebar-bottom-actions',
    'sidebar-bottom-btn',
    'new-session-composer-footer',
    'composer-icon-btn',
  ];
  const localCss = `${sessionsCss}\n${clientCss}\n${composerCss}`;

  for (const className of removed) {
    assert.doesNotMatch(runtimeSource, new RegExp(`className=[^\\n]*["'\\x60][^"'\\x60]*\\b${className}\\b`), className);
    assert.equal(ruleCount(localCss, `.${className}`), 0, className);
  }
});

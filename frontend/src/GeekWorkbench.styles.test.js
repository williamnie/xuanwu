import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const foundationCss = readFileSync(new URL('./GeekWorkbench.css', import.meta.url), 'utf8');
const pagesCss = readFileSync(new URL('./GeekWorkbenchPages.css', import.meta.url), 'utf8');
const piChatCss = readFileSync(new URL('./pages/PiChat.css', import.meta.url), 'utf8');

test('geek workbench styles load after the legacy app stylesheet', () => {
  const legacyIndex = appSource.indexOf("import './App.css';");
  const foundationIndex = appSource.indexOf("import './GeekWorkbench.css';");
  const pagesIndex = appSource.indexOf("import './GeekWorkbenchPages.css';");

  assert.ok(legacyIndex >= 0);
  assert.ok(foundationIndex > legacyIndex);
  assert.ok(pagesIndex > foundationIndex);
});

test('light and dark themes use separate workbench palettes', () => {
  assert.match(foundationCss, /:root\s*\{[\s\S]*--bg-primary:\s*#f3efe5/);
  assert.match(foundationCss, /:root\s*\{[\s\S]*--bg-card:\s*#fffdf8/);
  assert.match(foundationCss, /\[data-theme="dark"\]\s*\{[\s\S]*--bg-primary:\s*#070a0a/);
  assert.match(foundationCss, /\[data-theme="dark"\]\s*\{[\s\S]*--text-primary:\s*#eef7f2/);
  assert.match(foundationCss, /--font-display:/);
  assert.match(foundationCss, /--font-mono:/);
  assert.match(foundationCss, /--font-sans:\s*'PingFang SC'/);
  assert.match(foundationCss, /--font-display:\s*var\(--font-sans\)/);
  assert.match(foundationCss, /--radius-lg:\s*8px/);
  assert.match(foundationCss, /--radius-xl:\s*10px/);
  assert.match(foundationCss, /--button-radius:\s*0px/);
  assert.match(foundationCss, /--button-height:\s*40px/);
  assert.match(foundationCss, /--sessions-transcript-max-width:\s*980px/);
  assert.match(foundationCss, /--sessions-page-gutter:\s*clamp\(18px,\s*6vw,\s*88px\)/);
  assert.match(foundationCss, /\.status-badge,[^{]*\{[^}]*border-radius:\s*var\(--radius-xs\)/);
});

test('buttons use the flat E2B-inspired control language', () => {
  assert.match(foundationCss, /\.btn\s*\{[^}]*border-radius:\s*var\(--button-radius\)/);
  assert.match(foundationCss, /\.btn\s*\{[^}]*text-transform:\s*uppercase/);
  assert.match(foundationCss, /\.btn-primary\s*\{[^}]*background:\s*var\(--button-primary-bg\)/);
  assert.match(foundationCss, /\.btn-secondary\s*\{[^}]*border:\s*1px solid var\(--button-border\)/);
  assert.doesNotMatch(foundationCss, /\.btn-primary:hover[^}]*translateY/);
  assert.match(pagesCss, /button:not\(\.kanban-card-speed-toggle\),[\s\S]*border-radius:\s*var\(--button-radius\)\s*!important/);
  assert.doesNotMatch(pagesCss, /attention-inbox/);
});

test('page refinements keep chat layouts bounded on narrow screens', () => {
  assert.match(piChatCss, /\.pi-chat-shell\s*\{[\s\S]*grid-template-columns:\s*minmax\(272px, 298px\)\s+minmax\(0, 1fr\)/);
  assert.match(piChatCss, /@media \(max-width:\s*960px\)[\s\S]*\.pi-chat-shell\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('low-frequency global panels use the same visual system without owning Sessions page styles', () => {
  for (const selector of [
    '.approval-card',
    '.prompt-suggestion-menu',
    '.prompt-image-attachment-card',
    '.session-command-panel',
    '.codex-toast-item',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(pagesCss, new RegExp(escaped));
  }
  assert.match(pagesCss, /\.proposal-action-row\s*\{\s*border-radius:\s*var\(--radius-md\)/);
  assert.match(pagesCss, /\.settings-eyebrow,[^{]*\.eyebrow\s*\{[^}]*font-family:\s*var\(--font-sans\)/);
  assert.doesNotMatch(pagesCss, /\.settings-eyebrow,[^{]*\.eyebrow\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  assert.doesNotMatch(piChatCss, /\.pi-chat-runtime-pill[^}]*border-radius:\s*999px/);
  assert.doesNotMatch(pagesCss, /\.(?:sessions-client|client-chat|new-session|session-list-filter|session-info)/);
});

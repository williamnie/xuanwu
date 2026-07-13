import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const foundationCss = readFileSync(new URL('./GeekWorkbench.css', import.meta.url), 'utf8');
const pagesCss = readFileSync(new URL('./GeekWorkbenchPages.css', import.meta.url), 'utf8');

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
  assert.match(foundationCss, /--radius-lg:\s*9px/);
  assert.match(foundationCss, /--radius-xl:\s*11px/);
  assert.match(foundationCss, /--button-radius:\s*0px/);
  assert.match(foundationCss, /--button-height:\s*40px/);
  assert.match(foundationCss, /\.status-badge,[^{]*\{[^}]*border-radius:\s*var\(--radius-xs\)/);
});

test('buttons use the flat E2B-inspired control language', () => {
  assert.match(foundationCss, /\.btn\s*\{[^}]*border-radius:\s*var\(--button-radius\)/);
  assert.match(foundationCss, /\.btn\s*\{[^}]*text-transform:\s*uppercase/);
  assert.match(foundationCss, /\.btn-primary\s*\{[^}]*background:\s*var\(--button-primary-bg\)/);
  assert.match(foundationCss, /\.btn-secondary\s*\{[^}]*border:\s*1px solid var\(--button-border\)/);
  assert.doesNotMatch(foundationCss, /\.btn-primary:hover[^}]*translateY/);
  assert.match(pagesCss, /button:not\(\.kanban-card-speed-toggle\),[\s\S]*border-radius:\s*var\(--button-radius\)\s*!important/);
  assert.match(pagesCss, /\.attention-inbox-filter button\.active\s*\{[^}]*background:\s*var\(--button-primary-bg\)/);
});

test('page refinements keep chat layouts bounded on narrow screens', () => {
  assert.match(pagesCss, /\.pi-chat-shell\s*\{[\s\S]*grid-template-columns:\s*minmax\(272px, 298px\)\s+minmax\(0, 1fr\)/);
  assert.match(pagesCss, /@media \(max-width:\s*960px\)[\s\S]*\.pi-chat-shell\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(pagesCss, /\.attention-inbox-grid\s*\{\s*grid-template-columns:\s*1fr/);
});

test('low-frequency panels and mobile session controls use the same visual system', () => {
  for (const selector of [
    '.session-create-modal',
    '.approval-card',
    '.prompt-suggestion-menu',
    '.prompt-image-attachment-card',
    '.session-command-panel',
    '.codex-toast-item',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(pagesCss, new RegExp(escaped));
  }
  assert.match(pagesCss, /\.composer-embedded-select span\s*\{\s*white-space:\s*nowrap/);
  assert.match(pagesCss, /\.new-session-composer-wrapper \.prompt-composer-footer\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(pagesCss, /\.status-pill, \.attention-chip\s*\{\s*border-radius:\s*var\(--radius-xs\)/);
  assert.match(pagesCss, /\.session-list-filter-tab\s*\{[^}]*border-radius:\s*var\(--button-radius\)/);
  assert.match(pagesCss, /\.attention-empty\s*\{\s*border-radius:\s*var\(--radius-md\)/);
  assert.match(pagesCss, /\.attention-inbox-filter button, \.attention-actions button\s*\{[^}]*font-family:\s*var\(--font-sans\)/);
  assert.match(pagesCss, /\.settings-eyebrow,[^{]*\.eyebrow\s*\{[^}]*font-family:\s*var\(--font-sans\)/);
  assert.doesNotMatch(pagesCss, /\.settings-eyebrow,[^{]*\.eyebrow\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  assert.doesNotMatch(pagesCss, /\.pi-chat-runtime-pill[^}]*border-radius:\s*999px/);
});

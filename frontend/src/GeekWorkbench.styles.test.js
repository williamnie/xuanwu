import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const foundationCss = readFileSync(new URL('./GeekWorkbench.css', import.meta.url), 'utf8');
const pagesCss = readFileSync(new URL('./GeekWorkbenchPages.css', import.meta.url), 'utf8');
const piChatCss = readFileSync(new URL('./pages/PiChat.css', import.meta.url), 'utf8');
const piChatThreadCss = readFileSync(new URL('./pages/PiChatThread.css', import.meta.url), 'utf8');
const piChatSidebarCss = readFileSync(new URL('./pages/PiChatSidebar.css', import.meta.url), 'utf8');
const workBoardCss = readFileSync(new URL('./pages/WorkBoard.css', import.meta.url), 'utf8');
const designTokensCss = readFileSync(new URL('../../docs/design-system/tokens.css', import.meta.url), 'utf8');

test('geek workbench styles load after the legacy app stylesheet', () => {
  const legacyIndex = appSource.indexOf("import './App.css';");
  const foundationIndex = appSource.indexOf("import './GeekWorkbench.css';");
  const pagesIndex = appSource.indexOf("import './GeekWorkbenchPages.css';");

  assert.ok(legacyIndex >= 0);
  assert.ok(foundationIndex > legacyIndex);
  assert.ok(pagesIndex > foundationIndex);
});

test('runtime imports the canonical design tokens for both themes', () => {
  assert.match(foundationCss, /@import\s+['"]\.\.\/\.\.\/docs\/design-system\/tokens\.css['"]/);
  assert.match(designTokensCss, /:root\s*\{[\s\S]*--bg-primary:\s*#f3efe5/);
  assert.match(designTokensCss, /:root\s*\{[\s\S]*--bg-card:\s*rgba\(255,\s*253,\s*247,\s*0\.88\)/);
  assert.match(designTokensCss, /\[data-theme='dark'\]\s*\{[\s\S]*--bg-primary:\s*#070a0a/);
  assert.match(designTokensCss, /\[data-theme='dark'\]\s*\{[\s\S]*--text-primary:\s*#e2e7e4/);
  assert.match(designTokensCss, /--font-display:\s*'Inter'/);
  assert.match(designTokensCss, /--font-mono:\s*'JetBrains Mono'/);
  assert.match(designTokensCss, /--radius-lg:\s*10px/);
  assert.match(designTokensCss, /--button-radius:\s*0px/);
  assert.match(designTokensCss, /--button-height:\s*32px/);
  assert.match(designTokensCss, /--sessions-message-max-width:\s*1120px/);
  assert.match(designTokensCss, /--composer-max-width:\s*780px/);
  assert.match(designTokensCss, /--page-gutter:\s*clamp\(18px,\s*3vw,\s*42px\)/);
  assert.match(foundationCss, /--sessions-transcript-max-width:\s*var\(--sessions-message-max-width\)/);
  assert.match(foundationCss, /\.status-badge,[^{]*\{[^}]*border-radius:\s*var\(--radius-xs\)/);
});

test('buttons use the flat E2B-inspired control language', () => {
  assert.match(foundationCss, /\.btn\s*\{[^}]*border-radius:\s*var\(--button-radius\)/);
  assert.match(foundationCss, /\.btn\s*\{[^}]*text-transform:\s*uppercase/);
  assert.match(foundationCss, /\.btn-primary\s*\{[^}]*background:\s*var\(--button-primary-bg\)/);
  assert.match(foundationCss, /\.btn-secondary\s*\{[^}]*border:\s*1px solid var\(--button-border\)/);
  assert.doesNotMatch(foundationCss, /\.btn-primary:hover[^}]*translateY/);
  assert.match(pagesCss, /button:not\(\.composer-circle-submit\):not\(\.session-composer-circle\),[\s\S]*border-radius:\s*var\(--button-radius\)\s*!important/);
  assert.match(pagesCss, /\.composer-circle-submit,[\s\S]*border-radius:\s*50%\s*!important/);
  assert.doesNotMatch(pagesCss, /\.kanban-card-speed-toggle\s*\{[^}]*999px/);
  assert.doesNotMatch(pagesCss, /:hover[^}]*translateY\(-2px\)/);
  assert.doesNotMatch(pagesCss, /attention-inbox/);
});

test('page refinements keep chat layouts bounded on narrow screens', () => {
  assert.match(piChatCss, /\.pi-chat-shell\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(piChatCss, /\.pi-chat-main\s*\{[\s\S]*flex:\s*1/);
  assert.match(piChatThreadCss, /\.pi-chat-composer \.session-composer\s*\{[^}]*max-width:\s*var\(--composer-max-width\)/);
  assert.match(piChatThreadCss, /\.pi-chat-composer\s*\{[^}]*background:\s*transparent/);
  assert.doesNotMatch(piChatThreadCss, /\.pi-chat-composer\s*\{[^}]*backdrop-filter/);
  assert.doesNotMatch(piChatSidebarCss, /\.pi-chat-new-button[^}]*box-shadow:\s*0\s+[1-9]/);
  assert.doesNotMatch(piChatSidebarCss, /\.pi-chat-new-button:hover[^}]*transform:\s*translateY/);
});

test('code-split Work styles preserve the canonical button and panel geometry', () => {
  assert.match(workBoardCss, /\.work-action-primary\s*\{[^}]*background:\s*var\(--button-primary-bg\)/);
  assert.match(workBoardCss, /\.work-action-primary,[^{]*\.work-action-secondary\s*\{[^}]*border-radius:\s*var\(--button-radius\)/);
  assert.match(workBoardCss, /\.work-action-primary,[^{]*\.work-action-secondary\s*\{[^}]*min-height:\s*var\(--button-height\)/);
  assert.doesNotMatch(workBoardCss, /\.work-action-primary\s*\{[^}]*primary-gradient/);
  assert.doesNotMatch(workBoardCss, /--shadow-xl|--radius-xl|#[0-9a-fA-F]{6}/);
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
  assert.match(pagesCss, /\.settings-eyebrow,[^{]*\.eyebrow\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  assert.match(pagesCss, /\.settings-eyebrow,[^{]*\.eyebrow\s*\{[^}]*font-size:\s*0\.56rem/);
  assert.doesNotMatch(piChatCss, /\.pi-chat-runtime-pill[^}]*border-radius:\s*999px/);
  assert.doesNotMatch(pagesCss, /\.(?:sessions-client|client-chat|new-session|session-list-filter|session-info)/);
});

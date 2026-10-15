import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
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
  assert.match(indexCss, /@import\s+['"]\.\.\/\.\.\/docs\/design-system\/tokens\.css['"]/);
  assert.match(designTokensCss, /:root\s*\{[\s\S]*--bg-primary:\s*#f6f5f2/);
  assert.match(designTokensCss, /:root\s*\{[\s\S]*--bg-card:\s*#ffffff/);
  assert.match(designTokensCss, /\[data-theme='dark'\]\s*\{[\s\S]*--bg-primary:\s*#(?:070709|070a0a)/);
  assert.match(designTokensCss, /\[data-theme='dark'\]\s*\{[\s\S]*--text-primary:\s*#(?:ffffff|e2e7e4)/);
  assert.match(designTokensCss, /--font-display:\s*'Inter'/);
  assert.match(designTokensCss, /--font-mono:\s*'JetBrains Mono'/);
  assert.match(designTokensCss, /--radius-lg:\s*10px/);
  assert.match(designTokensCss, /--button-radius:\s*0px/);
  assert.match(designTokensCss, /--button-height:\s*32px/);
  assert.match(designTokensCss, /--sessions-message-max-width:\s*1120px/);
  assert.match(designTokensCss, /--composer-max-width:\s*780px/);
  assert.match(designTokensCss, /--page-gutter:\s*clamp\(18px,\s*3vw,\s*24px\)/);
  assert.match(designTokensCss, /--sessions-transcript-max-width:\s*var\(--sessions-message-max-width\)/);
  assert.match(foundationCss, /\.status-badge,[^{]*\{[^}]*border-radius:\s*var\(--radius-xs\)/);
});

test('primary colors in light and dark themes belong to the Xuanwu teal family and contrast with info and warning colors', () => {
  const lightPrimaryMatch = designTokensCss.match(/:root\s*\{[\s\S]*?--primary:\s*(#[0-9a-fA-F]{6})/);
  const darkPrimaryMatch = designTokensCss.match(/\[data-theme='dark'\]\s*\{[\s\S]*?--primary:\s*(#[0-9a-fA-F]{6})/);
  const lightInfoMatch = designTokensCss.match(/:root\s*\{[\s\S]*?--info:\s*(#[0-9a-fA-F]{6})/);
  const darkInfoMatch = designTokensCss.match(/\[data-theme='dark'\]\s*\{[\s\S]*?--info:\s*(#[0-9a-fA-F]{6})/);
  const lightWarningMatch = designTokensCss.match(/:root\s*\{[\s\S]*?--warning:\s*(#[0-9a-fA-F]{6})/);

  assert.ok(lightPrimaryMatch, 'light --primary should be defined');
  assert.ok(darkPrimaryMatch, 'dark --primary should be defined');
  assert.ok(lightInfoMatch, 'light --info should be defined');
  assert.ok(darkInfoMatch, 'dark --info should be defined');

  const lightPrimary = lightPrimaryMatch[1].toLowerCase();
  const darkPrimary = darkPrimaryMatch[1].toLowerCase();
  const lightInfo = lightInfoMatch[1].toLowerCase();
  const darkInfo = darkInfoMatch[1].toLowerCase();

  // Primary colors should be distinct from info colors
  assert.notEqual(lightPrimary, lightInfo, 'light --primary must differ from --info');
  assert.notEqual(darkPrimary, darkInfo, 'dark --primary must differ from --info');

  const getHue = (hex) => {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = (num >> 16) / 255;
    const g = ((num >> 8) & 255) / 255;
    const b = (num & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
    return h;
  };

  const lightPrimaryHue = getHue(lightPrimary);
  const darkPrimaryHue = getHue(darkPrimary);

  // Both should match the teal turtle logo (160° - 185°)
  assert.ok(
    lightPrimaryHue >= 160 && lightPrimaryHue <= 185,
    `light --primary hue (${lightPrimaryHue}°) should be in teal spectrum (160°-185°)`
  );
  assert.ok(
    darkPrimaryHue >= 160 && darkPrimaryHue <= 185,
    `dark --primary hue (${darkPrimaryHue}°) should be in teal spectrum (160°-185°)`
  );

  // Running state must read as a different hue from the brand teal
  assert.ok(Math.abs(getHue(darkInfo) - darkPrimaryHue) >= 30, 'dark --info must not collide with teal --primary');
  // Warning must not drift back into the orange brand range
  assert.ok(getHue(lightWarningMatch[1]) >= 32, 'light --warning should be amber-yellow, not orange');

  assert.equal(lightPrimary, '#0f766e');
  assert.equal(darkPrimary, '#2dd4bf');
});

test('terminal window decorative dots use neutral color and do not contain hardcoded red/yellow/green', () => {
  assert.match(foundationCss, /\.e2b-window-dots\s*\.e2b-dot\s*\{[^}]*background:\s*var\(--border-color-hover\)/);
  assert.doesNotMatch(foundationCss, /\.e2b-dot\.(?:red|yellow|green)/);
  assert.doesNotMatch(foundationCss, /\.e2b-window-dots[^}]*#(?:ef4444|f59e0b|10b981)/);
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
    '.prompt-suggestion-menu',
    '.prompt-image-attachment-card',
    '.codex-toast-item',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(pagesCss, new RegExp(escaped));
  }
  for (const [file, selector] of [['ApprovalDialog', 'approval-card'], ['SessionCommandPanel', 'session-command-panel']]) {
    const componentCss = readFileSync(new URL(`./pages/sessions/${file}.css`, import.meta.url), 'utf8');
    assert.ok(componentCss.includes(`.${selector}`));
    assert.ok(!pagesCss.includes(`.${selector}`), `${selector} must be owned by its component`);
  }
  assert.doesNotMatch(pagesCss, /\.session-command-chip/);
  assert.match(pagesCss, /\.proposal-action-row\s*\{\s*border-radius:\s*var\(--radius-md\)/);
  assert.match(pagesCss, /\.settings-eyebrow,[^{]*\.eyebrow\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  assert.match(pagesCss, /\.settings-eyebrow,[^{]*\.eyebrow\s*\{[^}]*font-size:\s*0\.56rem/);
  assert.doesNotMatch(piChatCss, /\.pi-chat-runtime-pill[^}]*border-radius:\s*999px/);
  assert.doesNotMatch(pagesCss, /\.(?:sessions-client|client-chat|new-session|session-list-filter|session-info)/);
});

test('active navigation and tabs use a thin primary indicator instead of brand fills or glows', () => {
  const sidebarCss = readFileSync(new URL('./components/AppSidebar.css', import.meta.url), 'utf8');
  const workDetailCss = readFileSync(new URL('./pages/WorkDetail.css', import.meta.url), 'utf8');

  assert.match(foundationCss, /\.nav-item\.active,[^{]*\{[^}]*color:\s*var\(--text-primary\)/);
  assert.doesNotMatch(sidebarCss, /\.nav-item\.active[^{]*\{[^}]*0 0 \d+px/);
  assert.doesNotMatch(foundationCss, /\.btn-primary[^{]*\{[^}]*box-shadow:\s*0 0 \d+px/);
  assert.match(workDetailCss, /\.work-detail-tabs button\[aria-selected='true'\]::after\s*\{[^}]*background:\s*var\(--primary\)/);
  assert.doesNotMatch(workDetailCss, /\.work-detail-tabs button\[aria-selected='true'\]\s*\{[^}]*--button-primary-bg/);
  assert.match(workBoardCss, /\.work-ledger-kicker\s*\{[^}]*color:\s*var\(--text-muted\)/);
});

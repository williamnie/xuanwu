import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const uncomment = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const styles = Object.fromEntries(readdirSync(root, { recursive: true })
  .filter(path => path.endsWith('.css'))
  .map(path => [path, uncomment(readFileSync(new URL(path, root), 'utf8'))]));
const tokens = uncomment(readFileSync(new URL('../../docs/design-system/tokens.css', import.meta.url), 'utf8'));
const spec = readFileSync(new URL('../../docs/design-system/spec.md', import.meta.url), 'utf8');
const normalize = text => text.replace(/\s+/g, ' ').trim();

// Exact selectors only: status/provider/project/timeline dots (spec 5.5),
// neutral terminal indicators (5.0), loading spinners (6), and composer submit (5.2).
// This is not a blanket exemption for any selector containing "dot" or "button".
const circles = {
  'index.css': ['.api-status-dot', '.sub-filter-dot', '.kanban-column-dot', '.status-dot'],
  'GeekWorkbench.css': ['.e2b-window-dots .e2b-dot'],
  'GeekWorkbenchPages.css': ['.composer-circle-submit, .session-composer-circle'],
  'components/CodexUsagePanel.css': ['.codex-provider-identity > span::before'],
  'pages/PiChatSidebar.css': ['.pi-chat-conversation-runtime > span'],
  'pages/Handoffs.css': ['.handoff-authority-note > span'],
  'pages/ProjectSettingsEditor.css': ['.project-settings-loading-hint::before'],
  'pages/IssueDetail.css': ['.issue-detail-tab > i', '.issue-activity-marker', '.issue-detail-loading__spinner'],
  'pages/Automations.css': ['.automation-status-dot', '.history-mark'],
  'pages/PiChatThread.css': ['.pi-chat-status-dot'],
  'pages/PiChatDiagnostics.css': ['.pi-chat-status-dot'],
  'pages/WorkBoard.css': ['.work-column-marker'],
  'pages/WorkDetail.css': ['.work-timeline-marker', '.work-run-list li > i'],
  'pages/Dashboard.css': ['.dashboard-hud-status'],
  'pages/IssueCard.css': ['.kanban-card-project-dot'],
  'pages/command-center/TaskRequestsSection.css': ['.ds-request-card > .dot'],
  'pages/command-center/RecentDeliveriesSection.css': ['.recent-delivery-status i'],
  'pages/command-center/ActiveWorkSection.css': ['.active-work-phase i'],
  'pages/runs/Runs.css': ['.run-status-dot', '.run-attempt-tabs button i', '.run-timeline-marker'],
  'pages/work/TaskList.css': ['.task-list-dot'],
  'pages/sessions/SessionComposer.css': ['.session-composer-circle'],
  'pages/sessions/Sessions.css': ['.runtime-status-dot', '.session-item-active-dot'],
  'pages/sessions/SessionsClient.css': ['.composer-circle-submit'],
};

// Spec 2 / 5.2 / 5.7: 10px belongs only to composer surfaces and user bubbles.
const largeRadii = {
  'components/GlobalAskComposer.css': ['.global-ask-composer-card', '.global-ask-composer-card .prompt-editor-shell.composer'],
  'components/editor/PromptEditor.css': ['.prompt-editor-shell.composer'],
  'pages/WorkBoard.css': ['.work-dialog-field .prompt-editor-shell.composer'],
  'pages/sessions/Sessions.css': ['.chat-bubble-container.user'],
  'pages/sessions/SessionComposer.css': ['.client-chat-composer-section .prompt-editor-shell.composer, .new-session-composer-wrapper .prompt-editor-shell.composer, .pi-chat-composer .prompt-editor-shell.composer'],
};

function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: normalize(selector), body }));
}

test('every frontend stylesheet uses canonical colors without literal fallbacks or retired aliases', () => {
  // The only color-literal owner is docs/design-system/tokens.css, outside this tree.
  // No component rgba/hex exceptions are needed: translucent overlays use color-mix.
  for (const [file, css] of Object.entries(styles)) {
    assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i, file);
    assert.doesNotMatch(css, /[: ,]\s*(?:white|black)\s*[;),]/i, file);
    assert.doesNotMatch(css, /--radius-xl\b|--shadow-md\b/, file);
  }
});

test('all component radii stay within the contract and circular exceptions remain explicit', () => {
  const seen = new Set();
  const seenLarge = new Set();
  for (const [file, css] of Object.entries(styles)) {
    for (const { selector, body } of rules(css)) {
      for (const [, value] of body.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius:\s*([^;]+);/g)) {
        if (/var\(--(?:radius-lg|sessions-composer-radius)\)/.test(value)) {
          assert.ok(largeRadii[file]?.includes(selector), `${file}: unlisted large radius ${selector}`);
          seenLarge.add(`${file}: ${selector}`);
        }
        assert.doesNotMatch(value, /[\d.]+(?:px|rem|em)\b/, `${file}: radius must use a token`);
        for (const [, amount, unit] of value.matchAll(/([\d.]+)(px|rem|em|%)/g)) {
          if (unit === '%') {
            assert.equal(Number(amount), 50, `${file}: ${selector}`);
            assert.ok(circles[file]?.includes(selector), `${file}: unlisted circle ${selector}`);
            seen.add(`${file}: ${selector}`);
          } else {
            assert.ok(Number(amount) * (unit === 'px' ? 1 : 16) <= 10, `${file}: ${selector}: ${value}`);
          }
        }
        assert.doesNotMatch(value, /var\(--(?!radius-(?:xs|sm|md|lg)\b|button-radius\b|sessions-composer-radius\b)/, file);
      }
    }
  }
  for (const [file, selectors] of Object.entries(largeRadii)) {
    for (const selector of selectors) assert.ok(seenLarge.has(`${file}: ${selector}`), `stale large-radius exemption: ${file}: ${selector}`);
  }
  for (const [file, selectors] of Object.entries(circles)) {
    for (const selector of selectors) assert.ok(seen.has(`${file}: ${selector}`), `stale circle exemption: ${file}: ${selector}`);
  }
});

test('flat surfaces allow only the workspace grid and documented new-session gradients', () => {
  for (const [file, css] of Object.entries(styles)) {
    for (const { selector, body } of rules(css)) {
      if (/(?:linear|radial|conic)-gradient\(/.test(body)) {
        assert.equal(file, 'GeekWorkbench.css');
        assert.equal(selector, '.bg-grid-tech, .main-content');
        assert.match(body, /background-size:\s*32px 32px/);
        assert.match(body, /background-position:\s*-1px -1px/);
        assert.equal((body.match(/linear-gradient\(/g) || []).length, 2);
        assert.equal((body.match(/var\(--grid-tech-line\)/g) || []).length, 2);
      }
      if (body.includes('var(--primary-gradient)')) {
        // Spec 5.4: only the sidebar's new-session entry may use a brand gradient.
        assert.ok(
          (file === 'pages/PiChatSidebar.css' && selector.split(', ').every(part => /\.sidebar-shortcut-item\.pi-chat-new-button(?::hover:not\(:disabled\))?$/.test(part)))
          || (file === 'pages/runs/Runs.css' && selector.split(', ').every(part => /^(?:\[data-theme="dark"\] )?\.runs-new-session-button(?::hover)?$/.test(part))),
          `${file}: ${selector}`,
        );
      }
    }
  }
});

test('shadows are tokenized with explicit non-shadow focus, status and inset-line exceptions', () => {
  for (const [file, css] of Object.entries(styles)) {
    assert.doesNotMatch(css, /(?:drop-shadow\(|text-shadow:)/, file);
    for (const { selector, body } of rules(css)) {
      for (const [, raw] of body.matchAll(/box-shadow:\s*([^;]+);/g)) {
        const value = normalize(raw).replace(/ !important$/, '');
        if (/^(?:none|var\(--shadow-(?:sm|lg)\))$/.test(value)) continue;
        if (value === '0 0 0 3px var(--primary-glow)') {
          assert.match(selector, /(?:focused|focus-within)/, `${file}: ${selector}`);
        } else if (value === '0 0 0 3px var(--info-glow)') {
          assert.match(selector, /running|recovering|created|in_progress|pi-chat-conversation-runtime/, `${file}: ${selector}`);
        } else if (value === '0 0 0 1000px var(--bg-card) inset') {
          // WebKit autofill background replacement; clipped inside the input, no outer shadow.
          assert.equal(file, 'index.css');
          assert.match(selector, /:-webkit-autofill/);
        } else {
          // Spec 5.3/5.4: thin inset active indicators and drop-target outlines, never blurred shadows.
          assert.match(selector, /active|selected|current|focus|drop/, `${file}: ${selector}`);
          assert.match(value, /^(?:inset (?:[23]px 0(?: 0)?|0 -2px 0) var\(--(?:primary|brand-mint)\)|inset 0 0 0 1px color-mix\(in srgb, var\(--(?:primary|error)\) \d+%, transparent\))$/, `${file}: ${value}`);
        }
      }
    }
  }
});

test('canonical tokens are imported once, documented, and never overridden by component styles', () => {
  assert.match(styles['index.css'], /@import ['"]\.\.\/\.\.\/docs\/design-system\/tokens\.css['"]/);
  assert.equal(Object.values(styles).filter(css => css.includes('@import')).length, 1);
  const names = new Set([...tokens.matchAll(/(--[\w-]+):/g)].map(match => match[1]));
  for (const name of names) {
    assert.ok(spec.includes(`| \`${name}\``), `${name} must appear in a spec table`);
    for (const [file, css] of Object.entries(styles)) {
      assert.doesNotMatch(css, new RegExp(`${name}:`), `${file} overrides ${name}`);
    }
  }
  for (const [, name, value] of tokens.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const row = spec.split('\n').find(line => line.startsWith(`| \`${name}\` |`));
    assert.ok(row.includes(`\`${value.trim()}\``), `${name}: ${value} differs from the documented values`);
  }
  for (const [, name] of tokens.matchAll(/var\((--[\w-]+)/g)) assert.ok(names.has(name), `undefined canonical alias ${name}`);
});

test('editor menus, attachments and toast own theme-neutral component surfaces', () => {
  for (const file of [
    'components/editor/PromptEditor.css',
    'components/editor/PromptEditorComposerImages.css',
    'components/editor/PromptEditorSuggestions.css',
    'components/editor/PromptEditorReferences.css',
    'components/ToastContainer.css',
  ]) assert.doesNotMatch(styles[file], /\[data-theme=|backdrop-filter:/, file);
  assert.doesNotMatch(styles['GeekWorkbenchPages.css'], /\.prompt-|\.codex-toast-/);
  const composerCard = rules(styles['components/GlobalAskComposer.css'])
    .find(rule => rule.selector === '.global-ask-composer-card');
  assert.match(composerCard.body, /overflow:\s*visible/, 'the suggestion menu must extend above the composer');
  assert.match(styles['components/GlobalAskComposer.css'], /@media \(max-width: 760px\)[\s\S]*?left:\s*12px;[\s\S]*?right:\s*12px;/);
});

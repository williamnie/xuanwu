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
  'index.css': ['.api-status-dot', '.status-dot'],
  'GeekWorkbench.css': ['.e2b-window-dots .e2b-dot'],
  'GeekWorkbenchPages.css': ['.composer-circle-submit, .session-composer-circle'],
  'components/CodexUsagePanel.css': ['.codex-provider-identity > span::before'],
  'pages/PiChatSidebar.css': ['.pi-chat-conversation-runtime > span'],
  'pages/Handoffs.css': ['.handoff-authority-note > span'],
  'pages/ProjectSettingsEditor.css': ['.project-settings-loading-hint::before'],
  'pages/Automations.css': ['.automation-status-dot', '.history-mark'],
  'pages/PiChatThread.css': ['.pi-chat-status-dot', '.pi-chat-thinking-signal'],
  'pages/PiChatDiagnostics.css': ['.pi-chat-status-dot'],
  'pages/WorkBoard.css': ['.work-column-marker'],
  'pages/WorkDetail.css': ['.work-timeline-marker', '.work-run-list li > i'],
  'pages/Dashboard.css': ['.dashboard-hud-status'],
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


test('selected tabs and language controls use neutral surfaces and a thin primary underline', () => {
  const targets = {
    'pages/runs/Runs.css': ".run-detail-section-tabs button[aria-current='page']",
    'pages/Settings.css': '.settings-language-options button.active',
  };
  for (const [file, selector] of Object.entries(targets)) {
    const rule = rules(styles[file]).find(rule => rule.selector.split(', ').includes(selector));
    assert.match(rule.body, /background: var\(--bg-card\)/, selector);
    assert.match(rule.body, /color: var\(--text-primary\)/, selector);
    const underline = rules(styles[file]).find(rule => rule.selector === `${selector}::after`);
    assert.match(underline.body, /height: 2px/, selector);
    assert.match(underline.body, /background: var\(--primary\)/, selector);
  }
  const reference = readFileSync(new URL('../../docs/design-system/components.css', import.meta.url), 'utf8');
  assert.match(reference, /\.ds-tabs button\[aria-current='page'\] \{ background: var\(--bg-card\)/);
  assert.match(reference, /\.ds-tabs button\[aria-current='page'\]::after \{[^}]*height: 2px/);
});


// Spec 5.5 / 6: loading spinners, running dots and the shared turtle loader.
const loopingMotion = {
  "index.css: .animate-spin, .spin-animation": "xuanwu-spin 1s linear infinite !important",
  "components/TurtleLoader.css: .turtle-loader-runner": "turtle-loader-crawl 2.8s linear infinite alternate",
  "pages/PiChatSidebar.css: .pi-chat-conversation-runtime[data-tone=\"running\"] > span": "pi-chat-runtime-spin 1s linear infinite",
  "pages/ProjectSettingsEditor.css: .project-settings-loading-hint::before": "xuanwu-spin 1s linear infinite",
  "pages/PiChatThread.css: .pi-chat-status-summary[data-tone=\"running\"] .pi-chat-status-dot": "pi-chat-running-signal 1.4s ease-in-out infinite",
  "pages/PiChatThread.css: .pi-chat-thinking-signal": "pi-chat-running-signal 1.4s ease-in-out infinite",
  "pages/WorkBoard.css: .is-spinning": "work-spin 1s linear infinite",
  "pages/WorkDetail.css: .work-run-list li[data-status='running'] > i, .work-run-list li[data-status='recovering'] > i, .work-run-list li[data-status='created'] > i": "work-run-pulse 1.4s ease-in-out infinite",
  "pages/runs/Runs.css: .run-attempt-tabs button[data-status='running'] i, .run-attempt-tabs button[data-status='created'] i": "run-attempt-pulse 1.4s ease-in-out infinite",
  "pages/work/TaskList.css: .task-list-dot[data-status='in_progress']": "task-list-pulse 1.4s ease-in-out infinite",
  "pages/sessions/Sessions.css: .project-order-saving": "spin 1s linear infinite",
  "pages/sessions/Sessions.css: .runtime-status-pill.running .runtime-status-dot": "pulse 1.4s ease-in-out infinite",
  "pages/sessions/Sessions.css: .spin-animation": "spin 1s linear infinite",
  "pages/sessions/Sessions.css: .session-item-loading": "spin 1s linear infinite"
};


test('motion stays within 180ms and loops are limited to named loading or running indicators', () => {
  const seen = new Set();
  for (const [file, css] of Object.entries(styles)) {
    assert.doesNotMatch(css, /transform:\s*[^;]*scale\(/, file);
    assert.doesNotMatch(css, /(?:transition|animation)-delay\s*:/, file);
    for (const { selector, body } of rules(css)) {
      const key = `${file}: ${selector}`;
      for (const [, value] of body.matchAll(/transition:\s*([^;]+);/g)) {
        if (value === 'none') continue;
        for (const part of value.split(/,(?![^()]*\))/)) {
          assert.match(part.trim(), /^(?:opacity|transform|background-color|border-color|color)\s/, key);
          for (const [, amount, unit] of part.matchAll(/([\d.]+)(ms|s)\b/g)) {
            assert.ok(Number(amount) * (unit === 's' ? 1000 : 1) <= 180, key);
          }
        }
      }
      for (const [, value] of body.matchAll(/animation:\s*([^;]+);/g)) {
        if (value.startsWith('none')) continue;
        if (value.includes('infinite')) {
          assert.equal(value, loopingMotion[key], `unlisted looping animation ${key}`);
          seen.add(key);
        } else {
          assert.match(value, /^(?:xuanwu-fade-in|toastSlideIn|clientFadeIn|slideDown)\s/, key);
          assert.doesNotMatch(value, /alternate|infinite/, key);
          for (const [, amount, unit] of value.matchAll(/([\d.]+)(ms|s)\b/g)) {
            assert.ok(Number(amount) * (unit === 's' ? 1000 : 1) <= 180, key);
          }
        }
      }
      for (const [, value] of body.matchAll(/(?:transition|animation)-duration:\s*([^;]+);/g)) {
        // Transcript spinner intentionally inherits the global 1s loading rhythm (spec 6).
        assert.equal(file, 'pages/sessions/SessionTranscript.css');
        assert.match(selector, /\.session-execution-summary \.spin-animation/);
        assert.equal(value, '1s');
      }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(loopingMotion).sort(), 'remove stale motion exceptions');
});

test('shared metadata roles use mono, uppercase and wide tracking', () => {
  const metadata = styles['components/Metadata.css'];
  assert.match(metadata, /font-family: var\(--font-mono\)/);
  assert.match(metadata, /letter-spacing: 0\.08em/);
  assert.match(metadata, /text-transform: uppercase/);
  for (const selector of ['.project-status-pill', '.nav-badge', '.status-badge', '.run-context-meta', '.work-detail-meta', '.task-list-meta', '.connector-diagnostics__badge', '.session-info-label']) {
    assert.ok(metadata.includes(`${selector},`) || metadata.includes(`${selector} {`), selector);
  }
  const targets = rules(metadata)[0].selector.split(', ');
  for (const [file, css] of Object.entries(styles)) {
    if (file === 'components/Metadata.css') continue;
    for (const { selector, body } of rules(css)) {
      if (selector.split(', ').some(part => targets.includes(part))) {
        assert.doesNotMatch(body, /(?:font-family|letter-spacing|text-transform):/, `${file}: ${selector} duplicates metadata typography`);
      }
    }
  }
});

test('visible composers reserve solid primary emphasis for the send action', () => {
  const css = styles['App.css'];
  for (const selector of [
    '.main-content:not(:has(.prompt-editor-shell.composer)):has(~ .global-ask-composer-shell.expanded) .btn-primary',
    '.runs-page-shell:has(.prompt-editor-shell.composer) .runs-new-session-button',
    '.pi-chat-page:has(.prompt-editor-shell.composer) .sidebar-shortcut-item.pi-chat-new-button',
  ]) {
    const rule = rules(css).find(rule => rule.selector.includes(selector) && !rule.selector.includes(':hover'));
    assert.match(rule.body, /background: var\(--button-secondary-bg\)/, selector);
    assert.match(rule.body, /color: var\(--text-primary\)/, selector);
  }
});


test('accepted typography and spacing tiers are exact and theme invariant', () => {
  const expected = {"--text-2xs": "0.6rem", "--text-xs": "0.68rem", "--text-sm": "0.72rem", "--text-md": "0.78rem", "--text-base": "0.875rem", "--text-lg": "0.95rem", "--text-xl": "1rem", "--text-2xl": "1.125rem", "--text-3xl": "1.5rem", "--text-4xl": "2rem", "--text-page": "clamp(1.4rem, 3vw, var(--text-4xl))", "--space-0-5": "2px", "--space-1": "4px", "--space-1-5": "6px", "--space-2": "8px", "--space-2-5": "10px", "--space-3": "12px", "--space-3-5": "14px", "--space-4": "16px", "--space-4-5": "18px", "--space-5": "20px", "--space-6": "24px", "--space-8": "32px"};
  for (const [name, value] of Object.entries(expected)) {
    const definitions = [...tokens.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
    assert.deepEqual(definitions.map(match => match[1].trim()), [value], name);
  }
  assert.match(tokens, /--button-height: 32px/);
  assert.match(spec, /小档 28px/);
  assert.match(spec, /2px 用于微间距/);
});

const typescaleContract = JSON.parse(readFileSync(new URL('./Global.typescale-contract.json', import.meta.url), 'utf8'));

test('migrated styles use scale tokens and scoped structural exceptions', () => {
  const scaleSources = { ...styles };
  for (const file of typescaleContract.migratedFiles.filter(file => file.startsWith('../../docs/'))) {
    const raw = readFileSync(new URL(file, root), 'utf8');
    scaleSources[file] = uncomment(file.endsWith('.html') ? [...raw.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n') : raw);
  }
  assert.deepEqual(typescaleContract.migratedFiles.filter(file => !file.startsWith('../../docs/')).sort(), Object.keys(styles).sort(), 'every frontend stylesheet participates in the scale contract');
  const seenTiny = new Set();
  const seenPanel = new Set();
  const seenStructural = new Set();
  const keyOf = row => `${row.file}: ${row.selector}: ${row.property}`;
  for (const file of typescaleContract.migratedFiles) {
    assert.ok(scaleSources[file] !== undefined, `missing migrated stylesheet ${file}`);
    for (const { selector, body } of rules(scaleSources[file])) {
      for (const [, property, raw] of body.matchAll(/(?<![-\w])(font-size|(?:padding|margin)(?:-[\w-]+)?|(?:column-|row-)?gap)\s*:\s*([^;]+)(?:;|$)/g)) {
        const value = normalize(raw).replace(/ !important$/, '');
        const key = keyOf({ file, selector, property });
        for (const [, token] of value.matchAll(/var\((--[\w-]+)\)/g)) {
          const tiers = property === 'font-size'
            ? /^--text-(?:2xs|xs|sm|md|base|lg|xl|2xl|3xl|4xl|page)$/
            : /^--(?:space-(?:0-5|1|1-5|2|2-5|3|3-5|4|4-5|5|6|8)|page-gutter|sessions-page-gutter|sidebar-width|button-height|project-modal-inline-padding)$/;
          assert.match(token, tiers, `${key}: unknown scale alias ${token}`);
          if (token === '--sidebar-width') assert.equal(key, 'index.css: .main-content: margin-left');
          if (token === '--button-height') assert.ok(typescaleContract.structuralValues.some(row => keyOf(row) === key && row.value === value), `${key}: control dimension used as arbitrary spacing`);
        }
        const withoutNegation = value.replace(/calc\(var\(--space-[\w-]+\) \* -1\)/g, '0');
        if (/[\d.]+(?:px|r?em|[sdl]?v[wh]|ch|ex|pt)\b/.test(value) || withoutNegation.includes('calc(')) {
          const allowed = typescaleContract.structuralValues.find(row => keyOf(row) === key && row.value === value);
          assert.ok(allowed?.reason, `${key}: unreviewed literal ${value}`);
          seenStructural.add(`${key}: ${value}`);
        } else if (property === 'font-size') {
          assert.match(value, /^(?:inherit|var\(--text-(?:2xs|xs|sm|md|base|lg|xl|2xl|3xl|4xl|page)\))$/, `${key}: unknown font tier ${value}`);
        }
        if (value.includes('var(--space-0-5)')) {
          const allowed = typescaleContract.microSpacing.find(row => keyOf(row) === key);
          const contexts = {
            'badge-inset': /^padding/,
            'stacked-text': /^(?:gap|row-gap|margin(?:-top|-bottom|-block(?:-start|-end)?)?)$/,
            'compact-list': /^(?:(?:row-|column-)?gap)$/,
            'inline-code': /^padding(?:-top|-bottom|-block(?:-start|-end)?)?$/,
          };
          assert.ok(allowed?.reason && contexts[allowed.context]?.test(property), `${key}: unlisted 2px micro-spacing context`);
          if (['stacked-text', 'inline-code'].includes(allowed.context) && /^(?:margin|padding)$/.test(property)) {
            const slots = value.split(/\s+/);
            assert.ok(slots.length > 1 && !slots[1].includes('--space-0-5') && !slots[3]?.includes('--space-0-5'), `${key}: micro spacing is vertical only`);
          }
          seenTiny.add(key);
        }
        if (/var\(--space-(?:3-5|4-5)\)/.test(value)) {
          assert.match(property, /^padding/, key);
          assert.ok(typescaleContract.panelPadding.some(row => keyOf(row) === key && row.reason), `${key}: unlisted panel inset`);
          seenPanel.add(key);
        }
      }
    }
  }
  for (const row of typescaleContract.structuralValues) assert.ok(seenStructural.has(`${keyOf(row)}: ${row.value}`), `stale structural exception ${keyOf(row)}`);
  for (const row of typescaleContract.microSpacing) assert.ok(seenTiny.has(keyOf(row)), `stale micro spacing ${keyOf(row)}`);
  for (const row of typescaleContract.panelPadding) assert.ok(seenPanel.has(keyOf(row)), `stale panel inset ${keyOf(row)}`);
});


test('component aliases and font shorthands cannot hide literal scale values', () => {
  const canonicalNames = new Set([...tokens.matchAll(/(--[\w-]+):/g)].map(match => match[1]));
  for (const [file, css] of Object.entries(styles)) {
    for (const [, name, value] of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      const target = value.trim().match(/^var\((--[\w-]+)\)$/)?.[1];
      assert.ok(canonicalNames.has(target), `${file}: ${name} must alias a canonical token`);
    }
    for (const [, value] of css.matchAll(/(?<![-\w])font:\s*([^;]+);/g)) {
      assert.equal(value.trim(), 'inherit', `${file}: use explicit font-family and font-size tokens`);
    }
  }
});

test('repeated cards and expanded panels use secondary actions within their interaction layer', () => {
  const read = file => readFileSync(new URL(file, root), 'utf8');
  const approval = read('pages/sessions/ApprovalDialog.jsx');
  assert.doesNotMatch(approval, /approval-btn primary/);
  assert.match(approval, /approval-btn secondary[^\n]*onResolve\('approve', 'turn'\)/);
  const secondaryTargets = {
    'pages/sessions/ApprovalDialog.css': '.approval-btn.secondary',
    'pages/sessions/SessionCommandPanel.css': '.session-command-actions .session-command-execute',
    'pages/command-center/AttentionSection.css': '.approval-decision-target>footer button.approve',
    'pages/command-center/ActiveWorkSection.css': '.active-work-confirm .confirm',
    'pages/Settings.css': '.settings-advanced-sections .btn-primary',
  };
  for (const [file, selector] of Object.entries(secondaryTargets)) {
    const rule = rules(styles[file]).find(rule => rule.selector === selector);
    assert.match(rule.body, /background:\s*var\(--button-secondary-bg\)/, selector);
    assert.match(rule.body, /border-color:\s*var\(--border-color\)/, selector);
    assert.match(rule.body, /color:\s*var\(--text-primary\)/, selector);
  }
  assert.doesNotMatch(read('pages/CodeAgentsPanel.jsx'), /btn-primary/);
  assert.match(read('pages/PiAgentSettingsPanel.jsx'), /className="btn btn-secondary" onClick=\{pending/);
  assert.match(read('pages/command-center/OnboardingSupervisorConnection.jsx'), /className="btn btn-secondary" disabled=\{state.oauthBusy\}/);
  const modal = rules(styles['pages/work/HumanReview.css']).find(rule => rule.selector === '.work-review-dialog button.primary');
  assert.match(modal.body, /background: var\(--button-primary-bg\)/);
  assert.match(spec, /2026-10-15 补充/);
  assert.match(spec, /最上层可交互模态/);
  assert.match(spec, /重复卡片操作统一 secondary/);
});

import { readStyleSources } from '../test-support/readStylesheet.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const uncomment = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const styles = Object.fromEntries(Object.entries(readStyleSources(root)).map(([path, css]) => [path, uncomment(css)]));
const tokens = uncomment(readFileSync(new URL('../../docs/design-system/tokens.css', import.meta.url), 'utf8'));
const spec = readFileSync(new URL('../../docs/design-system/spec.md', import.meta.url), 'utf8');
const normalize = text => text.replace(/\s+/g, ' ').trim();

function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: normalize(selector), body }));
}

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
  assert.match(read('pages/PiCodexOAuthPanel.jsx'), /className="btn btn-secondary" onClick=\{pending/);
  assert.match(read('pages/command-center/OnboardingSupervisorConnection.jsx'), /className="btn btn-secondary" disabled=\{state.oauthBusy\}/);
  const modal = rules(styles['pages/work/HumanReview.css']).find(rule => rule.selector === '.work-review-dialog button.primary');
  assert.match(modal.body, /background: var\(--button-primary-bg\)/);
  assert.match(spec, /2026-10-15 补充/);
  assert.match(spec, /最上层可交互模态/);
  assert.match(spec, /重复卡片操作统一 secondary/);
});

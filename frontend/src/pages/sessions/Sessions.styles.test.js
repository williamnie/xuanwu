import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const files = ['SessionsClient', 'Sessions', 'ApprovalDialog', 'SessionCommandPanel', 'SessionComposer'];
const styles = Object.fromEntries(files.map(name => [name, readFileSync(new URL(`./${name}.css`, import.meta.url), 'utf8')]));
const sourceRoot = new URL('../../', import.meta.url);
const runtimeTokens = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
const canonicalTokens = readFileSync(new URL('../../../../docs/design-system/tokens.css', import.meta.url), 'utf8');
const spec = readFileSync(new URL('../../../../docs/design-system/spec.md', import.meta.url), 'utf8');
const uncomment = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.ok(matches.length, `missing ${selector}`);
  return matches.map(match => match[1]).join('\n');
}

for (const [name, raw] of Object.entries(styles)) {
  const css = uncomment(raw);
  test(`${name} uses semantic colors, supported geometry and flat surfaces`, () => {
    assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i);
    assert.doesNotMatch(css, /--radius-xl|--shadow-md|(?:linear|radial)-gradient\(/);
    assert.doesNotMatch(css, /\[data-theme=/, 'themes must be handled by tokens');
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const [, radius] of body.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius:\s*([^;]+);/g)) {
        for (const [, value, unit] of radius.matchAll(/([\d.]+)(px|rem|em|%)/g)) {
          if (unit === '%') {
            assert.equal(Number(value), 50);
            assert.match(selectors, /runtime-status-dot|session-item-active-dot|composer-circle-submit|session-composer-circle/);
          } else {
            assert.ok(Number(value) * (unit === 'px' ? 1 : 16) <= 10, `${selectors}: ${radius}`);
          }
        }
        assert.doesNotMatch(radius, /var\(--(?!sessions-composer-radius|button-radius|radius-(?:xs|sm|md|lg)\b)/);
      }
      for (const [, shadow] of body.matchAll(/box-shadow:\s*([^;]+);/g)) {
        assert.match(shadow, /^(?:none|var\(--shadow-(?:sm|lg)\)|0 0 0 3px var\(--(?:primary|info)-glow\))$/);
        if (shadow.includes('info-glow')) assert.match(selectors, /running \.runtime-status-dot/);
        if (shadow.includes('primary-glow')) assert.match(selectors, /composer:focus-within/);
      }
    }
  });
}

test('retired aliases have no CSS definitions or references anywhere in the frontend', () => {
  for (const path of readdirSync(sourceRoot, { recursive: true }).filter(path => path.endsWith('.css'))) {
    assert.doesNotMatch(readFileSync(new URL(path, sourceRoot), 'utf8'), /--radius-xl\b|--shadow-md\b/, path);
  }
});

test('runtime and canonical radius and shadow values match the documented contract', () => {
  for (const name of ['button-radius', 'radius-xs', 'radius-sm', 'radius-md', 'radius-lg', 'shadow-sm', 'shadow-lg']) {
    const values = css => [...css.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))].map(match => match[1]);
    assert.deepEqual(values(runtimeTokens), values(canonicalTokens), name);
    assert.ok(spec.includes(`\`--${name}\``), `${name} must be documented`);
  }
});

test('approval and command cards own neutral surfaces and compact semantic labels', () => {
  for (const [name, selector] of [['ApprovalDialog', '.approval-card'], ['SessionCommandPanel', '.session-command-panel']]) {
    const card = rule(styles[name], selector);
    assert.match(card, /background:\s*var\(--surface-raised\)/);
    assert.match(card, /border:\s*1px solid var\(--border-color\)/);
    assert.match(card, /border-radius:\s*var\(--radius-md\)/);
    assert.doesNotMatch(card, /backdrop-filter/);
  }
  assert.match(rule(styles.ApprovalDialog, '.approval-card'), /box-shadow:\s*var\(--shadow-lg\)/);
  for (const [name, selector] of [['ApprovalDialog', '.approval-meta span'], ['SessionCommandPanel', '.session-command-chip']]) {
    const label = rule(styles[name], selector);
    assert.match(label, /font-family:\s*var\(--font-mono\)/);
    assert.match(label, /font-size:\s*0\.56rem/);
    assert.match(label, /text-transform:\s*uppercase/);
  }
});

test('terminal output uses the terminal palette and hides decorative traffic lights', () => {
  assert.match(rule(styles.Sessions, '.terminal-dots'), /display:\s*none/);
  assert.doesNotMatch(styles.Sessions + styles.SessionsClient, /\.terminal-dots \.dot/);
  const title = rule(styles.Sessions, '.terminal-title');
  assert.match(title, /font-family:\s*var\(--font-mono\)/);
  assert.match(title, /font-size:\s*0\.6rem/);
  for (const css of [styles.Sessions, styles.SessionsClient]) {
    for (const [, , body] of css.matchAll(/([^{}]*\.terminal-[^{}]*)\{([^{}]*)\}/g)) {
      for (const [, declaration] of body.matchAll(/(?:^|\n)\s*(?:background|color|border(?:-bottom)?):\s*([^;]+);/g)) {
        assert.match(declaration, /var\(--terminal-|^transparent$/);
      }
    }
  }
});

test('one user bubble surface wraps the message header and body without important overrides', () => {
  const bubble = rule(styles.Sessions, '.chat-bubble-container.user');
  assert.match(bubble, /background:\s*var\(--primary-glow\)/);
  assert.match(bubble, /border-radius:\s*var\(--radius-lg\)/);
  assert.match(bubble, /max-width:\s*min\(100%,\s*80%\)/);
  assert.doesNotMatch(styles.SessionsClient, /\.chat-bubble-body/);
  for (const [, , body] of styles.Sessions.matchAll(/([^{}]*\.chat-bubble[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(body, /!important/);
  }
  assert.match(rule(styles.SessionsClient, '.client-chat-area .session-message-avatar'), /background:\s*var\(--primary-glow\)/);
});

test('composer focus and submit controls preserve the two documented exceptions', () => {
  assert.doesNotMatch(styles.SessionComposer, /!important/);
  assert.match(styles.SessionComposer, /composer:focus-within\s*\{[^}]*border-color:\s*var\(--primary\);[^}]*box-shadow:\s*0 0 0 3px var\(--primary-glow\)/);
  assert.match(styles.SessionComposer, /\.ProseMirror\s*\{\s*min-height:\s*96px/);
  for (const [name, selector] of [['SessionComposer', '.session-composer-circle'], ['SessionsClient', '.composer-circle-submit']]) {
    const button = rule(styles[name], selector);
    assert.match(button, /width:\s*34px/);
    assert.match(button, /height:\s*34px/);
    assert.match(button, /border-radius:\s*50%/);
  }
});

test('narrow layouts wrap header actions without stretching user bubbles to full width', () => {
  assert.match(styles.SessionsClient, /@media \(max-width: 980px\)[\s\S]*?\.client-chat-area \.session-runtime-header\s*\{\s*flex-wrap:\s*wrap/);
  for (const [, , body] of styles.SessionsClient.matchAll(/([^{}]*\.chat-bubble-container\.user[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(body, /(?:max-)?width:\s*100%/);
  }
});

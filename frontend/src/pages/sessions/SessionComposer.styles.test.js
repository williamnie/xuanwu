import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./SessionComposer.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./SessionComposer.jsx', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('running queue hint is a compact bar directly above composer input', () => {
  const panelRule = ruleFor('.session-message-queue-panel');
  const hintRule = ruleFor('.session-message-queue-hint');
  const textRule = ruleFor('.session-message-queue-hint span');

  assert.match(panelRule, /margin-bottom:\s*6px/);
  assert.match(hintRule, /width:\s*fit-content/);
  assert.match(hintRule, /border-radius:\s*999px/);
  assert.match(hintRule, /padding:\s*4px\s+9px/);
  assert.match(hintRule, /font-size:\s*0\.73rem/);
  assert.match(textRule, /text-overflow:\s*ellipsis/);
  assert.match(textRule, /white-space:\s*nowrap/);
});

test('running queue hint uses concise status text', () => {
  assert.match(source, /className="session-message-queue-hint" role="status"/);
  assert.match(source, /发送会排队为下一条/);
  assert.doesNotMatch(source, /不会引导当前响应/);
});

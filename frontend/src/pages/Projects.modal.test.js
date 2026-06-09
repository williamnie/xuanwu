import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./Projects.css', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('project config modal is viewport bounded and scrollable', () => {
  assert.match(source, /className="glass-card modal-content project-config-modal"/);

  const rule = ruleFor('.project-config-modal');
  assert.match(rule, /max-height:\s*calc\(100vh - 48px\)/);
  assert.match(rule, /overflow-y:\s*auto/);
  assert.match(rule, /overscroll-behavior:\s*contain/);
});

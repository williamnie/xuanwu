import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cardSource = readFileSync(new URL('./IssueCard.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('issue cards render runtime data as compact metadata pills', () => {
  assert.match(cardSource, /kanban-card-heading/);
  assert.match(cardSource, /status-badge kanban-card-status/);
  assert.match(cardSource, /onClick=\{\(\) => onOpenIssue\(issue\.id\)\}/);
  assert.match(cardSource, /IssueRunMetadata/);
  assert.match(cardSource, /kanban-card-runtime-meta/);
  assert.match(cardSource, /RunMetaPill/);
  assert.doesNotMatch(cardSource, /kanban-card-run-grid/);
  assert.doesNotMatch(css, /\.kanban-card-run\s*\{/);

  assert.match(ruleFor('.kanban-card'), /padding:\s*11px 12px/);
  assert.match(ruleFor('.kanban-card'), /gap:\s*8px/);
  assert.match(ruleFor('.kanban-card-runtime-meta'), /flex-wrap:\s*wrap/);
  assert.match(ruleFor('.kanban-card-runtime-pill'), /border-radius:\s*999px/);
  assert.match(ruleFor('.kanban-card-runtime-pill'), /padding:\s*2px 6px/);
});

test('issue card runtime details stay available through tooltip text', () => {
  assert.match(cardSource, /runTooltipText/);
  assert.match(cardSource, /aria-label=\{runtimeTitle\}/);
  assert.match(cardSource, /title=\{runtimeTitle\}/);
  assert.match(cardSource, /`Session: \$\{sessionId \|\| '暂无'\}`/);
  assert.match(cardSource, /`Turn: \$\{turnId \|\| '暂无'\}`/);
});

test('todo cards expose dependency waiting without inventing a new issue status', () => {
  assert.match(cardSource, /issue\.status === 'todo'/);
  assert.match(cardSource, /issue\.dependency\?\.ready === false/);
  assert.match(cardSource, /IssueDependencySummary/);
  assert.match(cardSource, /dependency\.waiting_reason/);
  assert.match(ruleFor('.kanban-card-dependency'), /var\(--warning-bg\)/);
});

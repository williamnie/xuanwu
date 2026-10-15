import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const taskListCss = read('./TaskList.css');
const workBoardCss = read('../WorkBoard.css');
const geekPagesCss = read('../../GeekWorkbenchPages.css');
const tokens = read('../../../../docs/design-system/tokens.css');

test('task list rows are styled as distinct opaque cards with clear separation', () => {
  // Row list has gap between cards so items do not run into each other
  assert.match(taskListCss, /\.task-list-rows\s*\{[\s\S]*gap:\s*var\(--space-2\);/);

  // Each row has a solid surface and crisp border to prevent background grid lines from bleeding through
  assert.match(taskListCss, /\.task-list-row\s*\{[\s\S]*background:\s*var\(--surface-raised\);/);
  assert.match(taskListCss, /\.task-list-row\s*\{[\s\S]*border:\s*1px solid var\(--border-color\);/);
  assert.match(taskListCss, /\.task-list-row\s*\{[\s\S]*border-radius:\s*var\(--radius-sm\);/);

  // Hover state highlights the card
  assert.match(taskListCss, /\.task-list-row:hover\s*\{[\s\S]*background:\s*var\(--bg-card-hover\);/);
  assert.match(taskListCss, /\.task-list-row:hover\s*\{[\s\S]*border-color:\s*var\(--border-color-hover\);/);

  // No hardcoded colors or forbidden tokens
  assert.doesNotMatch(taskListCss, /#[a-f0-9]{3,8}\b/i);
  for (const [, token] of taskListCss.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.ok(tokens.includes(`${token}:`), `Token ${token} must be defined in tokens.css`);
  }
});

test('kanban columns in work board use solid opaque surfaces and no grid bleed-through', () => {
  // Column container is solid --bg-secondary and not transparent
  assert.match(workBoardCss, /\.work-column\s*\{[\s\S]*background:\s*var\(--bg-secondary\);/);
  assert.doesNotMatch(workBoardCss, /\.work-column\s*\{[^}]*color-mix\([^}]*transparent/);

  // Column header has a solid --surface-raised background and border
  assert.match(workBoardCss, /\.work-column-header\s*\{[\s\S]*background:\s*var\(--surface-raised\);/);
  assert.match(workBoardCss, /\.work-column-header\s*\{[\s\S]*border-bottom:\s*1px solid var\(--border-color\);/);

  // Dark mode refinements also preserve solid surfaces
  assert.match(geekPagesCss, /\[data-theme="dark"\] \.work-column\s*\{[\s\S]*background:\s*var\(--bg-secondary\);/);
  assert.match(geekPagesCss, /\[data-theme="dark"\] \.work-column-header\s*\{[\s\S]*background:\s*var\(--surface-raised\);/);

  // Empty placeholder has solid clearly visible border and complete corners without dashed clipping
  assert.match(workBoardCss, /\.work-column-empty\s*\{[\s\S]*border:\s*1px solid var\(--border-color-hover\);/);
  assert.match(workBoardCss, /\.work-column-empty\s*\{[\s\S]*border-radius:\s*var\(--radius-sm\);/);
  assert.doesNotMatch(workBoardCss, /\.work-column-empty\s*\{[^}]*dashed/);
});

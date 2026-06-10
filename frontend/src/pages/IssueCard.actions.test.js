import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cardSource = readFileSync(new URL('./IssueCard.jsx', import.meta.url), 'utf8');

test('issue card actions keep details on the card click and low-risk actions inline', () => {
  assert.match(cardSource, /onClick=\{\(\) => onOpenIssue\(issue\.id\)\}/);
  assert.doesNotMatch(cardSource, /onOpenLog/);
  assert.doesNotMatch(cardSource, />\s*Logs\s*</);
  assert.match(cardSource, /<ExternalLink size=\{12\} \/> Session/);
});

test('issue card more menu owns click bubbling and contains destructive actions', () => {
  assert.match(cardSource, /className="kanban-card-more"[\s\S]*onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(cardSource, /aria-haspopup="menu"/);
  assert.match(cardSource, /aria-expanded=\{moreOpen\}/);
  assert.match(cardSource, /role="menu"/);
  assert.match(cardSource, /const requestDelete = \(event\) => \{[\s\S]*onRequestDelete\(event, issue\)/);
  assert.match(cardSource, /role="menuitem"[\s\S]*onClick=\{requestDelete\}/);
  assert.doesNotMatch(cardSource, /kanban-card-action-btn danger/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cardSource = readFileSync(new URL('./IssueCard.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

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


test('issue card exposes speed as a compact lightning toggle', () => {
  assert.match(cardSource, /Zap,/);
  assert.match(cardSource, /function IssueSpeedToggle/);
  assert.match(cardSource, /className=\{className\}/);
  assert.match(cardSource, /aria-pressed=\{copy\.enabled\}/);
  assert.match(cardSource, /aria-label=\{copy\.ariaLabel\}/);
  assert.match(cardSource, /title=\{copy\.title\}/);
  assert.match(cardSource, /onServiceTierChange\(event, issue\.id, copy\.nextServiceTier\)/);
  assert.doesNotMatch(cardSource, /<select[\s\S]*serviceTierOptions/);
  assert.match(stylesSource, /\.kanban-card-speed-toggle\.off/);
  assert.match(stylesSource, /\.kanban-card-speed-toggle\.on/);
  assert.match(stylesSource, /fill:\s*currentColor/);
});

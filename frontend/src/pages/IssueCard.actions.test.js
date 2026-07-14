import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cardSource = readFileSync(new URL('./IssueCard.jsx', import.meta.url), 'utf8');
const moreSource = readFileSync(new URL('./IssueCardMoreActions.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

test('issue card actions keep details on the card click and low-risk actions inline', () => {
  assert.match(cardSource, /onClick=\{\(\) => onOpenIssue\(issue\.id\)\}/);
  assert.doesNotMatch(cardSource, /onOpenLog/);
  assert.doesNotMatch(cardSource, />\s*Logs\s*</);
  assert.match(cardSource, /<ExternalLink size=\{12\} \/> Session/);
});

test('issue card more menu owns click bubbling and contains destructive actions', () => {
  assert.match(moreSource, /className="kanban-card-more"[\s\S]*onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(moreSource, /aria-haspopup="menu"/);
  assert.match(moreSource, /aria-expanded=\{moreOpen\}/);
  assert.match(moreSource, /onMouseEnter=\{openMenu\}/);
  assert.match(moreSource, /role="menu"/);
  assert.match(moreSource, /onRequestDelete/);
  assert.match(moreSource, /role="menuitem"/);
  assert.match(moreSource, /label="Delete"/);
  assert.doesNotMatch(cardSource, /kanban-card-action-btn danger/);
});


test('issue card more menu is portaled and exposes edit action', () => {
  assert.match(cardSource, /onRequestEdit/);
  assert.match(cardSource, /canEditIssue\(issue\)/);
  assert.match(moreSource, /createPortal/);
  assert.match(moreSource, /placeFloatingMenu/);
  assert.match(moreSource, /label="Edit"/);
  assert.match(stylesSource, /\.kanban-card-more-menu\s*\{[\s\S]*position:\s*fixed/);
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

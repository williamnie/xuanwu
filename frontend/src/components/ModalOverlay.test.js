import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const component = readFileSync(new URL('./ModalOverlay.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const consumers = [
  './IssueEditModal.jsx',
  '../pages/Issues.jsx',
  '../pages/Projects.jsx',
  '../pages/WorkBoard.jsx',
  '../pages/WorkDetail.jsx',
  '../pages/issue-detail/IssueDetailActions.jsx',
  '../pages/issue-detail/IssueDetailDecision.jsx',
  '../pages/work/WorkEditorDialog.jsx',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('shared modal overlay portals dialogs to the viewport root', () => {
  assert.match(component, /createPortal\(/);
  assert.match(component, /globalThis\.document\?\.body/);
  assert.match(component, /className=\{overlayClassName\}/);
});

test('viewport modal consumers use the shared portal instead of nesting a fixed overlay', () => {
  for (const source of consumers) {
    assert.match(source, /<ModalOverlay(?:\s|>)/);
    assert.doesNotMatch(source, /<div[^>]+className="modal-overlay(?:\s[^"]*)?"/);
  }
});

test('shared modal overlay centers content and keeps tall dialogs scrollable', () => {
  const overlayRule = ruleFor('.modal-overlay');
  assert.match(overlayRule, /align-items:\s*center/);
  assert.match(overlayRule, /inset:\s*0/);
  assert.match(overlayRule, /justify-content:\s*center/);
  assert.match(overlayRule, /overflow:\s*auto/);
  assert.match(overlayRule, /position:\s*fixed/);
  assert.match(ruleFor('.modal-overlay > *'), /margin-block:\s*auto/);
});

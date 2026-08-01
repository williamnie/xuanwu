import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nextPromptEditorScrollTop,
  shouldKeepPromptEditorCaretVisible,
} from './promptEditorScroll.js';

test('Shift+Enter in a composer keeps the new caret line visible', () => {
  assert.equal(shouldKeepPromptEditorCaretVisible({ key: 'Enter', shiftKey: true }, true), true);
  assert.equal(shouldKeepPromptEditorCaretVisible({ key: 'Enter', shiftKey: false }, true), false);
  assert.equal(shouldKeepPromptEditorCaretVisible({ key: 'Enter', shiftKey: true }, false), false);
});

test('IME confirmation does not schedule a competing caret scroll', () => {
  assert.equal(
    shouldKeepPromptEditorCaretVisible({ key: 'Enter', shiftKey: true, isComposing: true }, true),
    false,
  );
  assert.equal(
    shouldKeepPromptEditorCaretVisible({ key: 'Enter', shiftKey: true, keyCode: 229 }, true),
    false,
  );
});

test('scrolls only enough to reveal a caret below the composer viewport', () => {
  assert.equal(nextPromptEditorScrollTop({
    caretBottom: 316,
    caretTop: 296,
    scrollTop: 120,
    viewportBottom: 300,
    viewportTop: 100,
  }), 140);
  assert.equal(nextPromptEditorScrollTop({
    caretBottom: 260,
    caretTop: 240,
    scrollTop: 120,
    viewportBottom: 300,
    viewportTop: 100,
  }), 120);
});

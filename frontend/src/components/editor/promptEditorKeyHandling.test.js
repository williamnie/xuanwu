import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handlePromptEditorSubmitKey,
  shouldSubmitPromptEditorKey,
} from './promptEditorKeyHandling.js';

function enterEvent(overrides = {}) {
  let prevented = false;
  return {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    preventDefault: () => { prevented = true; },
    get defaultPreventedForTest() { return prevented; },
    ...overrides,
  };
}

test('plain Enter submits the prompt editor and prevents newline insertion', () => {
  const event = enterEvent();
  let submitted = false;

  const handled = handlePromptEditorSubmitKey(event, () => { submitted = true; });

  assert.equal(handled, true);
  assert.equal(submitted, true);
  assert.equal(event.defaultPreventedForTest, true);
});

test('Shift+Enter keeps editor newline behavior', () => {
  const event = enterEvent({ shiftKey: true });
  let submitted = false;

  const handled = handlePromptEditorSubmitKey(event, () => { submitted = true; });

  assert.equal(handled, false);
  assert.equal(submitted, false);
  assert.equal(event.defaultPreventedForTest, false);
});

test('IME composition Enter does not submit', () => {
  const composingEvent = enterEvent({ isComposing: true });
  const confirmingEvent = enterEvent({ keyCode: 229 });

  assert.equal(shouldSubmitPromptEditorKey(composingEvent), false);
  assert.equal(shouldSubmitPromptEditorKey(confirmingEvent), false);
});

test('Enter without an enabled submit handler keeps editor behavior', () => {
  const event = enterEvent();

  const handled = handlePromptEditorSubmitKey(event, null);

  assert.equal(handled, false);
  assert.equal(event.defaultPreventedForTest, false);
});

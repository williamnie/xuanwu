import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handlePromptEditorImageTransfer,
  imageFilesFromTransfer,
} from './promptEditorImageTransfer.js';

test('reads image files exposed directly by a clipboard or drop transfer', () => {
  const image = { name: 'screenshot.png', type: 'image/png' };
  const text = { name: 'notes.txt', type: 'text/plain' };

  assert.deepEqual(imageFilesFromTransfer({ files: [text, image] }), [image]);
});

test('falls back to clipboard items when the files list is empty', () => {
  const image = { name: 'clipboard.png', type: 'image/png' };
  const transfer = {
    files: [],
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => image },
    ],
  };
  let uploaded = [];

  const handled = handlePromptEditorImageTransfer(transfer, (files) => {
    uploaded = files;
  });

  assert.equal(handled, true);
  assert.deepEqual(uploaded, [image]);
});

test('accepts clipboard image files when the item mime type is empty', () => {
  const image = { name: 'image.png', type: 'image/png' };
  const transfer = {
    files: [],
    items: [{ kind: 'file', type: '', getAsFile: () => image }],
  };

  assert.deepEqual(imageFilesFromTransfer(transfer), [image]);
});

test('accepts known image extensions when clipboard file mime is empty', () => {
  const image = { name: 'clipboard.webp', type: '' };
  assert.deepEqual(imageFilesFromTransfer({ files: [image] }), [image]);
});

test('leaves ordinary text paste to the editor', () => {
  let uploadCalled = false;

  const handled = handlePromptEditorImageTransfer({
    files: [],
    items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
  }, () => {
    uploadCalled = true;
  });

  assert.equal(handled, false);
  assert.equal(uploadCalled, false);
});

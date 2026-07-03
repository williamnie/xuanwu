import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createComposerImageAttachment,
  serializeComposerPrompt,
  splitComposerImageAttachments,
} from './composerImageAttachments.js';

test('composer extracts uploaded attachment images out of editable text', () => {
  const prompt = [
    '![first.png](attachment://upload_first)',
    '',
    '请分析这张图',
    '',
    '![second.png](attachment://upload_second)',
  ].join('\n');

  const result = splitComposerImageAttachments(prompt);

  assert.deepEqual(result.attachments, [
    { alt: 'first.png', src: 'attachment://upload_first' },
    { alt: 'second.png', src: 'attachment://upload_second' },
  ]);
  assert.equal(result.text, '请分析这张图');
});

test('composer serializes image attachments above the prompt body', () => {
  const serialized = serializeComposerPrompt([
    { alt: 'first.png', src: 'attachment://upload_first' },
    { alt: 'second.png', src: 'attachment://upload_second' },
  ], '继续保留文字');

  assert.equal(
    serialized,
    [
      '![first.png](attachment://upload_first)',
      '',
      '![second.png](attachment://upload_second)',
      '',
      '继续保留文字',
    ].join('\n'),
  );
});

test('composer keeps non-attachment markdown images in editable text', () => {
  const prompt = '![remote](https://example.com/a.png)\n\nhello';
  const result = splitComposerImageAttachments(prompt);

  assert.deepEqual(result.attachments, []);
  assert.equal(result.text, prompt);
});

test('composer image attachment metadata prefers uploaded original name', () => {
  assert.deepEqual(
    createComposerImageAttachment({ id: 'upload_123', original_name: '截图 1.png' }, { name: 'paste.png' }),
    { alt: '截图 1.png', src: 'attachment://upload_123' },
  );
  assert.equal(createComposerImageAttachment({}, { name: 'paste.png' }), null);
});

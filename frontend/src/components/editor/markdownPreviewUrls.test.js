import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as markdownUrls from './markdownPreviewUrls.js';

const previewSource = readFileSync(new URL('./MarkdownPreview.jsx', import.meta.url), 'utf8');

test('markdown preview URL transform resolves attachment images before sanitizing', () => {
  assert.equal(typeof markdownUrls.resolveMarkdownPreviewUrl, 'function');
  assert.equal(
    markdownUrls.resolveMarkdownPreviewUrl('attachment://upload_c8e60b2fa60040ecb65e7c22856d479c'),
    '/api/uploads/upload_c8e60b2fa60040ecb65e7c22856d479c/content',
  );
});

test('markdown preview keeps the safe default URL sanitizer for non-attachment URLs', () => {
  assert.equal(markdownUrls.resolveMarkdownPreviewUrl('/api/uploads/upload_test/content'), '/api/uploads/upload_test/content');
  assert.equal(markdownUrls.resolveMarkdownPreviewUrl('https://example.com/image.png'), 'https://example.com/image.png');
  assert.equal(markdownUrls.resolveMarkdownPreviewUrl('javascript:alert(1)'), '');
});

test('markdown preview proxies Codex clipboard image paths through the API', () => {
  const path = '/var/folders/d5/p8s9_bt93jqgdgy9pd0_vg940000gn/T/codex-clipboard-257e2d96-1dc0-4847-8a02-c90e77cf10ae.png';
  assert.equal(
    markdownUrls.resolveMarkdownPreviewUrl(path),
    `/api/session-images?path=${encodeURIComponent(path)}`,
  );
  assert.equal(
    markdownUrls.resolveMarkdownPreviewUrl(`file://${path}`),
    `/api/session-images?path=${encodeURIComponent(path)}`,
  );
});

test('MarkdownPreview wires the attachment-aware URL transform into react-markdown', () => {
  assert.match(previewSource, /urlTransform=\{resolveMarkdownPreviewUrl\}/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const issuesSource = readFileSync(new URL('./Issues.jsx', import.meta.url), 'utf8');

test('new issue template preview is collapsed by default', () => {
  const previewComponent = issuesSource.match(/function IssueTemplatePreview[\s\S]*?\n}\n$/)?.[0] || '';

  assert.match(previewComponent, /<details>/);
  assert.doesNotMatch(previewComponent, /<details\s+open/);
  assert.match(previewComponent, /<summary[^>]*>\s*模板渲染预览/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { codexImportNote, codexImportVisible } from './codexImportPreview.js';

const ready = summary => ({ status: 'ready', preview: { available: true, summary } });

test('Codex import button follows the read-only preview instead of probing the write endpoint', () => {
  assert.equal(codexImportVisible({ status: 'loading', preview: null }), false);
  assert.equal(codexImportVisible({ status: 'ready', preview: { available: false, reason: 'state_not_found' } }), false);
  assert.equal(codexImportVisible(ready({ discovered: 2, new: 0, existing: 0, enable_auto_run: 0, skipped: 2 })), false);
  assert.equal(codexImportVisible(ready({ discovered: 1, new: 1, existing: 0, enable_auto_run: 0, skipped: 0 })), true);
  assert.equal(codexImportVisible(ready({ discovered: 1, new: 0, existing: 1, enable_auto_run: 1, skipped: 0 })), true);
  // 预览接口不可用时退回旧行为：按钮始终显示，点击后给出明确结果。
  assert.equal(codexImportVisible({ status: 'error', preview: null }), true);
});

test('note states the auto-run side effect with real counts', () => {
  assert.equal(codexImportNote(ready({ discovered: 3, new: 2, existing: 1, enable_auto_run: 1, skipped: 0 })),
    '发现 2 个新工作区；导入会为 1 个已有项目开启自动执行。');
  assert.equal(codexImportNote(ready({ discovered: 1, new: 1, existing: 0, enable_auto_run: 0, skipped: 0 })),
    '发现 1 个新工作区；已有项目不受影响。');
  assert.match(codexImportNote({ status: 'error', preview: null }), /会对已有项目开启自动执行/);
});

test('both entry points gate the button on the preview and refresh it after importing', () => {
  for (const file of ['./Projects.jsx', './command-center/FirstDeliveryGuide.jsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /useCodexImportPreview\(\)/);
    assert.match(source, /codexImportVisible\(codexImport\)/);
    assert.match(source, /refreshCodexImport\(\)/);
    assert.doesNotMatch(source, /syncCodexProjects\(\)[\s\S]{0,40}useEffect/);
  }
});

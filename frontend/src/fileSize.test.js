import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

// 用户允许保留恰好 300 或略超的既有文件；新模块按 300 行约束。
const retainedLimits = {
  'pages/PiChatSidebar.css': 311,
  'pages/PiChatThread.css': 324,
  'pages/ProjectSettingsEditor.css': 307,
  'pages/sessions/sessionMarkdownExport.js': 304,
  'pages/sessions/VirtualSessionList.jsx': 317,
  'pages/work/WorkDeliveryView.jsx': 304,
};

test('frontend source modules stay within their line budget', () => {
  const root = new URL('./', import.meta.url);
  const oversized = readdirSync(root, { recursive: true })
    .filter(file => /\.(?:jsx?|tsx?|css|scss|less)$/.test(file))
    .flatMap(file => {
      const source = readFileSync(new URL(file, root), 'utf8');
      const lines = source.replace(/\n$/, '').split('\n').length;
      const limit = retainedLimits[file] || 300;
      return lines > limit ? [`${file}: ${lines} > ${limit}`] : [];
    });
  assert.deepEqual(oversized, [], '按组件或逻辑职责拆分超长模块');
});

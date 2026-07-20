import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panel = readFileSync(new URL('./EvidencePanel.jsx', import.meta.url), 'utf8');
const workBoard = readFileSync(new URL('../pages/WorkBoard.jsx', import.meta.url), 'utf8');
const sessionWorkspace = readFileSync(new URL('../pages/sessions/SessionChatWorkspace.jsx', import.meta.url), 'utf8');

test('Work and Run surfaces share the user-readable Evidence panel', () => {
  assert.match(workBoard, /<EvidencePanel title="Work Evidence" workId=\{work\.id\}/);
  assert.match(workBoard, /className="work-evidence-link"/);
  assert.match(sessionWorkspace, /showEvidence && selectedId \? <EvidencePanel compact sessionRef=\{selectedId\} title="Run Evidence"/);
});

test('Evidence panel has bounded list, empty/error states, artifact access and raw drill-down', () => {
  assert.match(panel, /const PAGE_SIZE = 5/);
  assert.match(panel, /暂无结构化证据/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /downloadArtifact/);
  assert.match(panel, /Raw \/ advanced/);
  assert.match(panel, /JSON\.stringify\(\{ evidence, storage_source: detail\.storage_source \}/);
  for (const reason of ['验证尚未执行', '验证结果未捕获', 'Evidence 与当前 Run 不匹配', 'Evidence 已过期', '验证失败']) {
    assert.match(panel, new RegExp(reason));
  }
  assert.match(panel, /response\?\.verification_gap/);
});

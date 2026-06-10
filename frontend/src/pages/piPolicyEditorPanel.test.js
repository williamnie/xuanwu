import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const panelUrl = new URL('./PiPolicyEditorPanel.jsx', import.meta.url);
const cssUrl = new URL('./PiPolicyEditorPanel.css', import.meta.url);
const commandSource = readFileSync(new URL('./PiCommandCenter.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const panelSource = existsSync(panelUrl) ? readFileSync(panelUrl, 'utf8') : '';
const cssSource = existsSync(cssUrl) ? readFileSync(cssUrl, 'utf8') : '';

test('Policy editor is mounted in Command Center and uses policy registry APIs', () => {
  assert.ok(existsSync(panelUrl), 'PiPolicyEditorPanel.jsx should exist');
  assert.match(commandSource, /import PiPolicyEditorPanel from '\.\/PiPolicyEditorPanel'/);
  assert.match(commandSource, /<PiPolicyEditorPanel onChanged=\{state\.reload\} \/>/);
  assert.match(panelSource, /api\.getProjectPiPolicy\(nextProjectId\)/);
  assert.match(panelSource, /api\.updateProjectPiPolicy\(form\.projectId, buildPolicyPayload\(form\)\)/);
  assert.match(panelSource, /api\.getPiSkills\(\)/);
  assert.match(panelSource, /api\.getPiMcpCapabilities\(\)/);
  assert.match(clientSource, /getPiSkills:/);
  assert.match(clientSource, /getPiMcpCapabilities:/);
});

test('Policy form captures policy, working hours, actions, skill and MCP allowlists', () => {
  for (const label of [
    '默认执行模式', '时区', '工作日', '工作开始时间', '工作结束时间',
    '允许动作', '允许技能', '允许的 MCP 工具能力'
  ]) {
    assert.match(panelSource, new RegExp(label));
  }
  assert.match(panelSource, /buildPolicyPayload\(form\)/);
  assert.match(panelSource, /allowed_actions: parseCSV\(form\.allowedActions\)/);
  assert.match(panelSource, /allowed_skill_intents: parseCSV\(form\.allowedSkills\)/);
  assert.match(panelSource, /allowed_mcp_capabilities: parseCSV\(form\.allowedMcp\)/);
});

test('Policy editor uses Chinese primary copy for buttons, notices, and validation', () => {
  for (const copy of ['执行策略', '刷新', '重置', '保存策略', '执行策略已保存', '尚未保存执行策略']) {
    assert.match(panelSource, new RegExp(copy));
  }
  for (const oldCopy of ['Save policy', 'Policy saved', 'Last saved', 'Policy not persisted yet']) {
    assert.doesNotMatch(panelSource, new RegExp(oldCopy));
  }
  assert.doesNotMatch(panelSource, />\\s*Refresh\\s*</);
});

test('Policy editor has inline errors, reset, and no native blocking prompts', () => {
  assert.match(panelSource, /validatePolicyForm\(form\)/);
  assert.match(panelSource, /resetToLoadedPolicy/);
  assert.match(panelSource, /className="pi-policy-error"/);
  assert.match(panelSource, /role="alert"/);
  assert.match(cssSource, /\.pi-policy-error/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { projectOptionLabel } from './projectOptionLabel.js';
import { useDataStore } from '../store/dataStore.js';
import { nodesApi } from '../api/nodes.js';

const remote = { id: 'project-1', name: '项目', node_id: 'node-1' };

test('项目选项保留本机名称，远程名称包含节点名，未知节点退回 ID', () => {
  const nodes = new Map([['node-1', { name: '开发机' }]]);
  assert.equal(projectOptionLabel({ ...remote, node_id: '' }, nodes), '项目');
  assert.equal(projectOptionLabel(remote, nodes), '项目 · 远程 · 开发机');
  assert.equal(projectOptionLabel(remote), '项目 · 远程 · node-1');
  assert.equal(projectOptionLabel(remote, new Map()), '项目 · 远程 · node-1');
  assert.equal(projectOptionLabel(remote, new Map([['node-1', { name: '' }]])), '项目 · 远程 · node-1');
  assert.equal(projectOptionLabel({ id: 'local', name: '' }, nodes, ''), '');
  assert.equal(projectOptionLabel({ id: 'local', name: '' }, nodes), 'local');
});

test('所有项目选项共用标签函数和节点缓存，包括自动化的两处选择器', () => {
  const expected = new Map([
    ['work/WorkEditorDialog.jsx', 1], ['WorkBoard.jsx', 1],
    ['command-center/FirstDeliveryGuide.jsx', 1], ['command-center/DeliveryEffectivenessSection.jsx', 1],
    ['ExecutionPresetsPanel.jsx', 1], ['Handoffs.jsx', 1], ['GitHubSettingsPanel.jsx', 1],
    ['SkillLibraryPanel.jsx', 1], ['Automations.jsx', 2], ['TelegramProjectMappings.jsx', 1],
    ['sessions/NewSessionWorkspace.jsx', 1],
  ]);
  for (const [file, count] of expected) {
    const source = readFileSync(new URL(`../pages/${file}`, import.meta.url), 'utf8');
    const options = [...source.matchAll(/<option\b[^>]*value=\{project.id\}[^>]*>([\s\S]*?)<\/option>/g)];
    assert.equal(options.length, count, file);
    for (const option of options) assert.match(option[1], /projectOptionLabel\(project, nodesById,/, file);
    assert.match(source, /const nodesById = useProjectNodes\(\)/, file);
    assert.doesNotMatch(source, /nodesApi\.listNodes/, file);
  }
  const root = new URL('../', import.meta.url);
  for (const file of readdirSync(root, { recursive: true }).filter(file => file.endsWith('.jsx'))) {
    const source = readFileSync(new URL(file, root), 'utf8');
    for (const option of source.matchAll(/<option\b[^>]*value=\{project.id\}[^>]*>([\s\S]*?)<\/option>/g)) {
      assert.match(option[1], /projectOptionLabel\(/, file);
    }
  }
});

test('节点请求合并并缓存，加载失败保留节点名且不改变页面连接状态，过期可恢复', async t => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  let resolve;
  const request = t.mock.method(nodesApi, 'listNodes', () => new Promise(done => { resolve = done; }));
  const refresh = useDataStore.getState().refreshNodes;
  const first = refresh();
  assert.equal(refresh(), first);
  resolve({ nodes: [{ id: 'node-1', name: '开发机' }] });
  await first;
  await refresh();
  assert.equal(request.mock.callCount(), 1);
  assert.equal(projectOptionLabel(remote, useDataStore.getState().nodesById), '项目 · 远程 · 开发机');
  now += 60_001;
  useDataStore.setState({ backendOnline: true });
  request.mock.mockImplementation(async () => { throw new Error('offline'); });
  await refresh();
  assert.equal(projectOptionLabel(remote, useDataStore.getState().nodesById), '项目 · 远程 · 开发机');
  assert.equal(useDataStore.getState().nodesById.get('node-1').online, undefined);
  assert.equal(useDataStore.getState().backendOnline, true);
  now += 60_001;
  request.mock.mockImplementation(async () => ({ nodes: [{ id: 'node-1', name: '新名称' }] }));
  await refresh();
  assert.equal(projectOptionLabel(remote, useDataStore.getState().nodesById), '项目 · 远程 · 新名称');
});

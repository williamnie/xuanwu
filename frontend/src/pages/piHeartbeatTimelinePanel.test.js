import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./PiHeartbeatTimelinePanel.jsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('./PiHeartbeatTimelinePanel.css', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const commandCenterSource = readFileSync(new URL('./PiCommandCenter.jsx', import.meta.url), 'utf8');

test('PI Command Center renders the heartbeat timeline module', () => {
  assert.match(commandCenterSource, /import PiHeartbeatTimelinePanel from '\.\/PiHeartbeatTimelinePanel'/);
  assert.match(commandCenterSource, /<PiHeartbeatTimelinePanel \/>/);
  assert.match(panelSource, /Heartbeat Timeline/);
  assert.match(panelSource, /signal \/ decision \/ action \/ result/);
});

test('heartbeat timeline supports project and issue filters through the API client', () => {
  assert.match(clientSource, /getPiHeartbeatTimeline:/);
  assert.match(clientSource, /\/api\/pi\/heartbeat-timeline/);
  assert.match(clientSource, /project_id/);
  assert.match(clientSource, /issue_id/);
  assert.match(panelSource, /timeline\.filters\.projectId/);
  assert.match(panelSource, /timeline\.filters\.issueId/);
  assert.match(panelSource, /type="number"/);
});

test('heartbeat timeline keeps long payloads inside the layout', () => {
  assert.match(panelSource, /<pre>\{details\}<\/pre>/);
  assert.match(cssSource, /overflow-wrap: anywhere/);
  assert.match(cssSource, /white-space: pre-wrap/);
  assert.match(cssSource, /grid-template-columns: 84px minmax\(0, 1fr\)/);
});

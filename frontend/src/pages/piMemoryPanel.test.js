import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('../api/piMemoryClient.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('./PiMemoryPanel.jsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');

test('PI memory panel exposes review, promotion, edit, disable, and delete controls', () => {
  assert.match(settingsSource, /import PiMemoryPanel from '\.\/PiMemoryPanel'/);
  assert.match(settingsSource, /<PiMemoryPanel \/>/);
  assert.match(clientSource, /list:\s*\(filter = \{\}\)/);
  assert.match(clientSource, /promote:\s*\(id\)/);
  assert.match(clientSource, /disable:\s*\(id\)/);
  assert.match(clientSource, /update:\s*\(id, updates\)/);
  assert.match(clientSource, /remove:\s*\(id\)/);
  assert.match(panelSource, /piMemoryApi\.promote\(item\.id\)/);
  assert.match(panelSource, /piMemoryApi\.disable\(item\.id\)/);
  assert.match(panelSource, /piMemoryApi\.update\(item\.id/);
  assert.match(panelSource, /piMemoryApi\.remove\(item\.id\)/);
  assert.match(panelSource, /activeCount/);
  assert.match(panelSource, /candidateCount/);
  assert.match(panelSource, /recentCandidateSource/);
  assert.match(panelSource, /Runner Chat \/ manager cycle \/ supervisor/);
  assert.match(panelSource, /failure-pattern generator/);
  assert.match(panelSource, /memory_write_candidate/);
  assert.match(panelSource, /必须人工启用后才会注入 prompt/);
  assert.doesNotMatch(panelSource, /window\.confirm/);
  assert.doesNotMatch(panelSource, /window\.alert/);
});

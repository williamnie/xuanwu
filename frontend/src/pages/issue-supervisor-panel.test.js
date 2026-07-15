import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./IssueSupervisorPanel.jsx', import.meta.url), 'utf8');
const workSource = readFileSync(new URL('../api/work.js', import.meta.url), 'utf8');

test('Issue Detail supervisor panel reads diagnosis, retry wait, recovery history, and rationale', () => {
  assert.match(workSource, /getIssueSupervisor:/);
  assert.match(workSource, /\/api\/issues\/\$\{id\}\/supervisor/);
  assert.match(panelSource, /function RetryAfterCard/);
  assert.match(panelSource, /Diagnosis/);
  assert.match(panelSource, /Last provider error/);
  assert.match(panelSource, /429 \/ retry-after wait/);
  assert.match(panelSource, /Decision rationale/);
  assert.match(panelSource, /Executed recovery message/);
  assert.match(panelSource, /Recovery history/);
  assert.doesNotMatch(panelSource, /window\.alert|window\.confirm/);
});

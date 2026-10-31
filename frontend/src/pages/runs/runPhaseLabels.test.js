import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RUN_PHASE_META, runPhaseLabel } from './runPhaseLabels.js';
import { activeWorkView } from '../command-center/activeWorkModel.js';
import { runStatusLabel } from './runPageModel.js';

test('labels cover every phase the progress projector can return', () => {
  const source = readFileSync(new URL('../../../../backend-ts/src/events/runProgressProjector.ts', import.meta.url), 'utf8');
  const union = source.match(/export type RunProgressPhase =([\s\S]*?);/)[1];
  for (const [, phase] of union.matchAll(/"([a-z_]+)"/g)) {
    assert.ok(RUN_PHASE_META[phase], phase);
    assert.equal(runPhaseLabel(phase), RUN_PHASE_META[phase].label);
  }
  assert.equal(runPhaseLabel('future_phase'), '状态未知');
  assert.equal(runPhaseLabel(null), '状态未知');
});

test('dashboard uses the shared phase labels without changing its task-level decision phase', () => {
  assert.equal(activeWorkView({ status: 'needs_user' }).phaseLabel, runPhaseLabel('waiting_approval'));
  assert.equal(activeWorkView({ status: 'in_progress', latest_run: { ended_at: '2026-10-29T00:00:00Z' } }).phaseLabel, '玄武助手判断中');
  for (const phase of ['cancelled', 'interrupted']) {
    assert.equal(runPhaseLabel(phase), runStatusLabel(phase));
    assert.equal(activeWorkView({ latest_run: { phase } }).phaseLabel, runStatusLabel(phase));
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { turtleAssetForState } from './brandAssets.js';
import { faviconHrefForState } from './brandFavicon.js';
import { BRAND_STATES, isNightTime, resolveRunnerBrandState } from './brandState.js';

const DAY = new Date(2026, 6, 2, 14, 0, 0);
const NIGHT = new Date(2026, 6, 2, 23, 0, 0);

test('runner brand state prioritizes offline and active issue work', () => {
  assert.equal(resolveRunnerBrandState({ backendOnline: false, now: DAY }), BRAND_STATES.offline);
  assert.equal(resolveRunnerBrandState({ issues: [{ status: 'in_progress', title: 'Fix UI' }], now: NIGHT }), BRAND_STATES.running);
  assert.equal(resolveRunnerBrandState({ issues: [
    { status: 'in_progress', title: 'Fix UI' },
    { status: 'in_progress', title: 'Ship API' },
  ], now: DAY }), BRAND_STATES.speed);
});

test('runner brand state uses guardian turtle for verifier work', () => {
  const state = resolveRunnerBrandState({
    issues: [{ status: 'in_progress', title: 'Verifier: #42 quality gate' }],
    now: DAY,
  });
  assert.equal(state, BRAND_STATES.guarding);
});

test('runner brand state switches idle, monitor, and night watch turtles', () => {
  assert.equal(resolveRunnerBrandState({ now: DAY }), BRAND_STATES.idle);
  assert.equal(resolveRunnerBrandState({ projects: [{ auto_run: 1 }], now: DAY }), BRAND_STATES.monitor);
  assert.equal(resolveRunnerBrandState({ automations: [{ status: 'active' }], now: DAY }), BRAND_STATES.monitor);
  assert.equal(resolveRunnerBrandState({ projects: [{ auto_run: 1 }], now: NIGHT }), BRAND_STATES.sleeping);
  assert.equal(isNightTime(new Date('2026-07-02T07:30:00+08:00')), true);
});

test('brand and favicon states use generated turtle PNG assets', () => {
  assert.equal(turtleAssetForState(BRAND_STATES.idle), '/brand-turtles/turtle-idle.png');
  assert.equal(turtleAssetForState(BRAND_STATES.running), '/brand-turtles/turtle-running.png');
  assert.equal(turtleAssetForState(BRAND_STATES.speed), '/brand-turtles/turtle-speed.png');
  assert.equal(turtleAssetForState(BRAND_STATES.guarding), '/brand-turtles/turtle-guarding.png');
  assert.equal(faviconHrefForState(BRAND_STATES.sleeping), '/brand-turtles/turtle-sleeping.png');
});

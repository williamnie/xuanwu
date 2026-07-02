import assert from 'node:assert/strict';
import test from 'node:test';
import { BRAND_STATES, isNightTime, resolveRunnerBrandState } from './brandState.js';
import { faviconHrefForState, faviconSvgForState } from './brandFavicon.js';

const DAY = new Date('2026-07-02T14:00:00+08:00');
const NIGHT = new Date('2026-07-02T23:00:00+08:00');

test('runner brand state prioritizes offline and active issue work', () => {
  assert.equal(resolveRunnerBrandState({ backendOnline: false, now: DAY }), BRAND_STATES.offline);
  assert.equal(resolveRunnerBrandState({ issues: [{ status: 'in_progress', title: 'Fix UI' }], now: NIGHT }), BRAND_STATES.running);
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
  assert.equal(resolveRunnerBrandState({ projects: [{ auto_run: 1 }], now: NIGHT }), BRAND_STATES.sleeping);
  assert.equal(isNightTime(new Date('2026-07-02T07:30:00+08:00')), true);
});

test('dynamic favicon exposes distinct turtle SVG data for states', () => {
  const running = faviconSvgForState(BRAND_STATES.running);
  const sleeping = decodeURIComponent(faviconHrefForState(BRAND_STATES.sleeping));
  assert.notEqual(running, sleeping);
  assert.match(running, /M8 33H2|M9 33H3/);
  assert.match(sleeping, /#fef3c7/);
});

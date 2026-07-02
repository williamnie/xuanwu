import { BRAND_STATES, normalizeBrandState } from './brandState.js';

const TURTLE_ASSETS = Object.freeze({
  [BRAND_STATES.idle]: 'turtle-idle.png',
  [BRAND_STATES.monitor]: 'turtle-monitor.png',
  [BRAND_STATES.running]: 'turtle-running.png',
  [BRAND_STATES.speed]: 'turtle-speed.png',
  [BRAND_STATES.guarding]: 'turtle-guarding.png',
  [BRAND_STATES.sleeping]: 'turtle-sleeping.png',
  [BRAND_STATES.offline]: 'turtle-idle.png',
});

export function turtleAssetForState(state = BRAND_STATES.idle) {
  return `/brand-turtles/${TURTLE_ASSETS[normalizeBrandState(state)]}`;
}

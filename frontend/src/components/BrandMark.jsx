import { BRAND } from '../brand';
import { BRAND_STATES, normalizeBrandState } from './brandState.js';
import { turtleAssetForState } from './brandAssets.js';

const STATE_TITLES = Object.freeze({
  [BRAND_STATES.idle]: 'Xuanwu idle turtle',
  [BRAND_STATES.monitor]: 'Xuanwu monitoring turtle',
  [BRAND_STATES.running]: 'Xuanwu terminal turtle',
  [BRAND_STATES.speed]: 'Xuanwu speedy turtle',
  [BRAND_STATES.guarding]: 'Xuanwu guardian turtle',
  [BRAND_STATES.sleeping]: 'Xuanwu night watch turtle',
  [BRAND_STATES.offline]: 'Xuanwu offline turtle',
});

export function XuanwuLogo({ className = 'xuanwu-logo', state = BRAND_STATES.idle, title = '' }) {
  const resolvedState = normalizeBrandState(state);
  const label = title || STATE_TITLES[resolvedState];

  return (
    <img
      alt={label}
      className={`${className} turtle-logo turtle-logo-img`}
      data-brand-state={resolvedState}
      draggable="false"
      src={turtleAssetForState(resolvedState)}
      title={label}
    />
  );
}

export default function BrandMark({ className = '', compact = false, state = BRAND_STATES.idle }) {
  const resolvedState = normalizeBrandState(state);
  const classes = ['brand-lockup', compact ? 'brand-lockup-compact' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} aria-label={`${BRAND.hanzi} ${BRAND.name}`} data-brand-state={resolvedState}>
      <div className="brand-mark-icon" aria-hidden="true">
        <XuanwuLogo state={resolvedState} title="" />
      </div>
      {!compact && <BrandWordmark />}
    </div>
  );
}

function BrandWordmark() {
  return (
    <div className="brand-wordmark">
      <strong>{BRAND.name}</strong>
      <span>{BRAND.hanzi} · {BRAND.descriptor}</span>
    </div>
  );
}

import { BRAND } from '../brand';
import { BRAND_STATES, normalizeBrandState } from './brandState.js';

const STATE_TITLES = Object.freeze({
  [BRAND_STATES.idle]: 'Xuanwu idle turtle',
  [BRAND_STATES.monitor]: 'Xuanwu monitoring turtle',
  [BRAND_STATES.running]: 'Xuanwu running issue turtle',
  [BRAND_STATES.guarding]: 'Xuanwu guardian turtle',
  [BRAND_STATES.sleeping]: 'Xuanwu night watch turtle',
  [BRAND_STATES.offline]: 'Xuanwu offline turtle',
});

export function XuanwuLogo({ className = 'xuanwu-logo', state = BRAND_STATES.idle, title = '' }) {
  const resolvedState = normalizeBrandState(state);
  const label = title || STATE_TITLES[resolvedState];

  return (
    <svg
      className={`${className} turtle-logo turtle-logo-${resolvedState}`}
      role="img"
      aria-label={label}
      viewBox="0 0 64 64"
      focusable="false"
      data-brand-state={resolvedState}
    >
      <title>{label}</title>
      <TurtleCanvas state={resolvedState} />
    </svg>
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

function TurtleCanvas({ state }) {
  return (
    <>
      <TurtleBackdrop />
      {state === BRAND_STATES.running ? <RunningTurtle /> : null}
      {state === BRAND_STATES.guarding ? <GuardingTurtle /> : null}
      {state === BRAND_STATES.monitor ? <MonitorTurtle /> : null}
      {state === BRAND_STATES.sleeping ? <SleepingTurtle /> : null}
      {state === BRAND_STATES.offline ? <OfflineTurtle /> : null}
      {state === BRAND_STATES.idle ? <IdleTurtle /> : null}
    </>
  );
}

function TurtleBackdrop() {
  return (
    <>
      <circle className="turtle-glow" cx="22" cy="14" r="18" />
      <path className="turtle-ground" d="M13 49c7 4 30 4 38 0" />
    </>
  );
}

function IdleTurtle() {
  return (
    <g className="turtle turtle-idle">
      <path className="turtle-limb" d="M19 42l-5 5M45 42l5 5M18 32l-6-2M46 32l6-2" />
      <ellipse className="turtle-shell" cx="32" cy="36" rx="16" ry="12" />
      <circle className="turtle-body" cx="32" cy="20" r="8" />
      <path className="turtle-plate" d="M22 36h20M32 25v23M25 29c3 4 4 9 2 16M39 29c-3 4-4 9-2 16" />
      <circle className="turtle-eye" cx="29" cy="19" r="1.7" />
      <circle className="turtle-eye" cx="35" cy="19" r="1.7" />
      <path className="turtle-smile" d="M29 24c2 1.8 4.2 1.8 6 0" />
    </g>
  );
}

function MonitorTurtle() {
  return (
    <g className="turtle turtle-monitor">
      <path className="turtle-limb" d="M19 42l-5 4M45 42l5 4M18 32l-6-2M46 32l6-2" />
      <ellipse className="turtle-shell" cx="32" cy="37" rx="16" ry="11" />
      <circle className="turtle-body" cx="32" cy="21" r="8" />
      <path className="turtle-antenna" d="M32 12V6m0 0 4 3m-4-3-4 3" />
      <path className="turtle-plate turtle-signal" d="M24 36h16M27 30c3 2.4 7 2.4 10 0M26 42h12" />
      <circle className="turtle-eye" cx="29" cy="20" r="1.6" />
      <circle className="turtle-eye" cx="35" cy="20" r="1.6" />
    </g>
  );
}

function RunningTurtle() {
  return (
    <g className="turtle turtle-running">
      <path className="turtle-speed" d="M9 33H3M11 41H6" />
      <path className="turtle-limb" d="M20 44l-7 5M35 44l8 4M18 30l-7-4M36 29l8-4" />
      <ellipse className="turtle-shell" cx="29" cy="37" rx="17" ry="11" />
      <circle className="turtle-body" cx="47" cy="31" r="7" />
      <path className="turtle-plate" d="M19 37h17M25 28c3 5 3 11 0 16M34 30c-2 4-2 8 0 12" />
      <circle className="turtle-eye" cx="49" cy="29" r="1.6" />
      <path className="turtle-smile" d="M47 35c1.4 1 3 1 4 0" />
    </g>
  );
}

function GuardingTurtle() {
  return (
    <g className="turtle turtle-guarding">
      <path className="turtle-limb" d="M18 42l-6 5M46 42l6 5" />
      <path className="turtle-shield-shell" d="M32 18 48 25v11c0 10-6 17-16 21-10-4-16-11-16-21V25l16-7Z" />
      <circle className="turtle-body" cx="32" cy="17" r="7" />
      <path className="turtle-plate turtle-shield-line" d="M32 25v25M23 34h18M25 42h14" />
      <circle className="turtle-eye" cx="29" cy="16" r="1.5" />
      <circle className="turtle-eye" cx="35" cy="16" r="1.5" />
    </g>
  );
}

function SleepingTurtle() {
  return (
    <g className="turtle turtle-sleeping">
      <circle className="turtle-moon" cx="47" cy="18" r="5" />
      <circle className="turtle-moon-cut" cx="50" cy="16" r="5" />
      <circle className="turtle-star" cx="50" cy="29" r="1.4" />
      <ellipse className="turtle-shell" cx="31" cy="39" rx="17" ry="11" />
      <circle className="turtle-body" cx="18" cy="32" r="7" />
      <path className="turtle-plate" d="M23 39h17M27 31c3 4 3 10 0 15" />
      <path className="turtle-sleep-eye" d="M15 31h5" />
    </g>
  );
}

function OfflineTurtle() {
  return (
    <g className="turtle turtle-offline">
      <ellipse className="turtle-shell" cx="32" cy="39" rx="17" ry="10" />
      <path className="turtle-plate" d="M19 37c5-7 21-7 26 0M24 31h16M25 45h14" />
      <path className="turtle-limb" d="M18 44l-6 4M46 44l6 4" />
    </g>
  );
}

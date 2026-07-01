import { BRAND } from '../brand';

export function XuanwuLogo({ className = 'xuanwu-logo', title = 'Xuanwu brand mark' }) {
  return (
    <svg className={className} role="img" aria-label={title} viewBox="0 0 64 64" focusable="false">
      <title>{title}</title>
      <path className="xuanwu-shield" d="M32 4 54 13.5v17.2c0 13.9-8.7 25.4-22 29.3-13.3-3.9-22-15.4-22-29.3V13.5L32 4Z" />
      <path className="xuanwu-snake" d="M18.5 19.5c-5.7-3.1-4.8-10.3 1.9-11.2 4.8-.6 7.3 2.5 7.9 6.2" />
      <path className="xuanwu-shell" d="M17 35.2c0-9.2 6.8-16.6 15-16.6s15 7.4 15 16.6c0 8.6-6 14.2-15 14.2s-15-5.6-15-14.2Z" />
      <path className="xuanwu-head" d="M46 30.6c4.3-.8 7.8 1.4 8.6 4.7.5 2.1-.5 4.3-2.6 5.3-2.7 1.3-5.6-.1-6.9-2.5" />
      <path className="xuanwu-plate" d="M32 19v30M22.2 29.2h19.6M20.2 38.2h23.6M25.1 21.9c3.2 3.3 4.7 7.6 4.7 13.1m9.1-13.1c-3.2 3.3-4.7 7.6-4.7 13.1" />
      <path className="xuanwu-limb" d="M19.1 44.2 14 48.8m30.9-4.6 5.1 4.6M18.3 29.4l-5.4-2.7m32.8 2.7 5.4-2.7" />
      <circle className="xuanwu-eye" cx="50.2" cy="34.2" r="1.2" />
    </svg>
  );
}

export default function BrandMark({ className = '', compact = false }) {
  const classes = ['brand-lockup', compact ? 'brand-lockup-compact' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} aria-label={`${BRAND.hanzi} ${BRAND.name}`}>
      <div className="brand-mark-icon" aria-hidden="true">
        <XuanwuLogo title="" />
      </div>
      {!compact && (
        <div className="brand-wordmark">
          <strong>{BRAND.name}</strong>
          <span>{BRAND.hanzi} · {BRAND.descriptor}</span>
        </div>
      )}
    </div>
  );
}

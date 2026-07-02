import { useEffect } from 'react';
import { BRAND_STATES, normalizeBrandState } from './brandState.js';

const FAVICON_BACKGROUND = {
  [BRAND_STATES.idle]: ['#5eead4', '#0f766e'],
  [BRAND_STATES.monitor]: ['#67e8f9', '#0f766e'],
  [BRAND_STATES.running]: ['#a7f3d0', '#0e7490'],
  [BRAND_STATES.guarding]: ['#d9f99d', '#166534'],
  [BRAND_STATES.sleeping]: ['#99f6e4', '#0f172a'],
  [BRAND_STATES.offline]: ['#cbd5e1', '#475569'],
};

const FAVICON_ART = {
  [BRAND_STATES.idle]: '<ellipse cx="31" cy="35" rx="16" ry="12" fill="#d7f4df" stroke="#052e2b" stroke-width="3"/><circle cx="31" cy="19" r="8" fill="#baf7d0" stroke="#052e2b" stroke-width="3"/><circle cx="28" cy="18" r="1.7" fill="#052e2b"/><circle cx="34" cy="18" r="1.7" fill="#052e2b"/><path d="M27 23c2 2 6 2 8 0" stroke="#052e2b" stroke-width="2" stroke-linecap="round"/><path d="M20 39l-6 5M42 39l6 5M17 30l-7-2M45 30l7-2" stroke="#052e2b" stroke-width="3" stroke-linecap="round"/>',
  [BRAND_STATES.monitor]: '<ellipse cx="31" cy="36" rx="16" ry="12" fill="#d7f4df" stroke="#052e2b" stroke-width="3"/><circle cx="31" cy="20" r="8" fill="#baf7d0" stroke="#052e2b" stroke-width="3"/><path d="M31 11V5m0 0 4 3m-4-3-4 3" stroke="#052e2b" stroke-width="2.4" stroke-linecap="round"/><circle cx="28" cy="19" r="1.6" fill="#052e2b"/><circle cx="34" cy="19" r="1.6" fill="#052e2b"/><path d="M24 36h14M26 29c4 3 6 3 10 0" stroke="#0f766e" stroke-width="2.2" stroke-linecap="round"/>',
  [BRAND_STATES.running]: '<ellipse cx="28" cy="36" rx="17" ry="11" fill="#d7f4df" stroke="#052e2b" stroke-width="3"/><circle cx="47" cy="30" r="7" fill="#baf7d0" stroke="#052e2b" stroke-width="3"/><circle cx="49" cy="28" r="1.6" fill="#052e2b"/><path d="M20 43l-7 5M34 44l8 4M19 29l-8-3M36 28l8-4M8 33H2M10 40H5" stroke="#052e2b" stroke-width="3" stroke-linecap="round"/><path d="M20 36h15M25 28c3 5 3 10 0 15" stroke="#0f766e" stroke-width="2" stroke-linecap="round"/>',
  [BRAND_STATES.guarding]: '<path d="M31 17 47 24v12c0 11-6 18-16 22-10-4-16-11-16-22V24l16-7Z" fill="#d7f4df" stroke="#052e2b" stroke-width="3"/><circle cx="31" cy="16" r="7" fill="#baf7d0" stroke="#052e2b" stroke-width="3"/><circle cx="28" cy="15" r="1.5" fill="#052e2b"/><circle cx="34" cy="15" r="1.5" fill="#052e2b"/><path d="M31 24v25M22 33h18M24 42h14" stroke="#166534" stroke-width="2.4" stroke-linecap="round"/><path d="M16 39l-6 5M46 39l6 5" stroke="#052e2b" stroke-width="3" stroke-linecap="round"/>',
  [BRAND_STATES.sleeping]: '<ellipse cx="30" cy="38" rx="17" ry="12" fill="#d7f4df" stroke="#052e2b" stroke-width="3"/><circle cx="17" cy="31" r="7" fill="#baf7d0" stroke="#052e2b" stroke-width="3"/><path d="M14 30h5M23 38h14M26 31c4 4 4 9 0 14" stroke="#052e2b" stroke-width="2.2" stroke-linecap="round"/><circle cx="47" cy="18" r="5" fill="#fef3c7"/><circle cx="50" cy="16" r="5" fill="#0f172a"/><circle cx="49" cy="29" r="1.6" fill="#fef3c7"/><circle cx="54" cy="25" r="1.1" fill="#fef3c7"/>',
  [BRAND_STATES.offline]: '<ellipse cx="31" cy="38" rx="17" ry="11" fill="#e2e8f0" stroke="#334155" stroke-width="3"/><path d="M18 36c5-8 21-8 26 0M23 29h16M25 45h12" stroke="#64748b" stroke-width="2.4" stroke-linecap="round"/><path d="M18 44l-6 4M44 44l6 4" stroke="#334155" stroke-width="3" stroke-linecap="round"/>',
};

export function faviconSvgForState(state = BRAND_STATES.idle) {
  const resolved = normalizeBrandState(state);
  const [from, to] = FAVICON_BACKGROUND[resolved];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#g)"/><g>${FAVICON_ART[resolved]}</g></svg>`;
}

export function faviconHrefForState(state) {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvgForState(state))}`;
}

export function applyDynamicFavicon(state, doc = globalThis.document) {
  if (!doc?.head) return;
  const link = findOrCreateFaviconLink(doc);
  link.setAttribute('data-runner-brand-icon', 'true');
  link.setAttribute('type', 'image/svg+xml');
  link.setAttribute('href', faviconHrefForState(state));
}

export function useDynamicFavicon(state) {
  useEffect(() => {
    applyDynamicFavicon(state);
  }, [state]);
}

function findOrCreateFaviconLink(doc) {
  const selector = 'link[rel="icon"][data-runner-brand-icon], link[rel="icon"]';
  const existing = doc.querySelector(selector);
  if (existing) return existing;
  const link = doc.createElement('link');
  link.setAttribute('rel', 'icon');
  doc.head.appendChild(link);
  return link;
}

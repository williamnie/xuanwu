import { useEffect } from 'react';
import { BRAND_STATES } from './brandState.js';
import { turtleAssetForState } from './brandAssets.js';

export function faviconHrefForState(state = BRAND_STATES.idle) {
  return turtleAssetForState(state);
}

export function applyDynamicFavicon(state, doc = globalThis.document) {
  if (!doc?.head) return;
  const link = findOrCreateFaviconLink(doc);
  link.setAttribute('data-runner-brand-icon', 'true');
  link.setAttribute('type', 'image/png');
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

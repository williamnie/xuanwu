import { PRODUCT_ROUTE_ALIASES } from './pages/assistantModules.js';

// Replace only the route ID. Re-serializing URLSearchParams would change the
// encoding, ordering, duplicates and unknown parameters of existing links.
export function canonicalAppHash(hash) {
  const value = String(hash || '');
  const match = /^#\/?([^/?]+)([\s\S]*)$/.exec(value);
  if (!match) return value;
  let page;
  try {
    page = decodeURIComponent(match[1]).trim();
  } catch {
    return value;
  }
  return Object.hasOwn(PRODUCT_ROUTE_ALIASES, page)
    ? `#/${PRODUCT_ROUTE_ALIASES[page]}${match[2]}`
    : value;
}

export function watchCanonicalAppHash(browser = globalThis) {
  if (!browser.history || !browser.location || !browser.addEventListener) return undefined;
  const normalize = () => {
    const hash = canonicalAppHash(browser.location.hash);
    if (hash === browser.location.hash) return;
    const href = `${browser.location.pathname}${browser.location.search}${hash}`;
    browser.history.replaceState(browser.history.state, '', href);
  };
  normalize();
  browser.addEventListener('hashchange', normalize);
  browser.addEventListener('popstate', normalize);
  return () => {
    browser.removeEventListener('hashchange', normalize);
    browser.removeEventListener('popstate', normalize);
  };
}

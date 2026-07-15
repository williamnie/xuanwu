import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const brandSource = readFileSync(new URL('./BrandMark.jsx', import.meta.url), 'utf8');
const brandConstants = readFileSync(new URL('../brand.js', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('./AppSidebar.jsx', import.meta.url), 'utf8');
const authSource = readFileSync(new URL('./AuthGate.jsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('Xuanwu brand constants and logo are available to app chrome', () => {
  assert.match(brandConstants, /productLatin:\s*'Xuanwu'/);
  assert.match(brandConstants, /product:\s*'玄武'/);
  assert.match(brandConstants, /descriptor:\s*'AI Engineering Control Plane'/);
  assert.match(brandSource, /function XuanwuLogo/);
  assert.match(brandSource, /turtle-logo-img/);
  assert.match(brandSource, /turtleAssetForState/);
  assert.match(brandSource, /data-brand-state/);
});

test('sidebar and auth gate use Xuanwu brand instead of hardcoded xiaobei badge', () => {
  assert.match(sidebarSource, /import BrandMark from '\.\/BrandMark'/);
  assert.match(sidebarSource, /<BrandMark className="sidebar-brand" state=\{brandState\} \/>/);
  assert.match(sidebarSource, /useDynamicFavicon\(brandState\)/);
  assert.doesNotMatch(sidebarSource, /\bXB\b|xiaobei/);
  assert.match(authSource, /BRAND\.hanzi/);
  assert.match(authSource, /BRAND\.name/);
});

test('brand visual system includes Xuanwu CSS and favicon title metadata', () => {
  assert.match(cssSource, /--brand-jade/);
  assert.match(cssSource, /\.brand-mark-icon/);
  assert.match(cssSource, /\.turtle-logo-img/);
  assert.match(cssSource, /background:\s*transparent/);
  assert.match(cssSource, /data-brand-state="running"/);
  assert.match(indexHtml, /brand-turtles\/turtle-idle\.png/);
  assert.match(indexHtml, /玄武 Xuanwu · AI Engineering Control Plane/);
});

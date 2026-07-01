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
  assert.match(brandConstants, /name:\s*'Xuanwu'/);
  assert.match(brandConstants, /hanzi:\s*'玄武'/);
  assert.match(brandSource, /function XuanwuLogo/);
  assert.match(brandSource, /xuanwu-shell/);
});

test('sidebar and auth gate use Xuanwu brand instead of hardcoded xiaobei badge', () => {
  assert.match(sidebarSource, /import BrandMark from '\.\/BrandMark'/);
  assert.match(sidebarSource, /<BrandMark className="sidebar-brand" \/>/);
  assert.doesNotMatch(sidebarSource, /\bXB\b|xiaobei/);
  assert.match(authSource, /BRAND\.hanzi/);
  assert.match(authSource, /BRAND\.name/);
});

test('brand visual system includes Xuanwu CSS and favicon title metadata', () => {
  assert.match(cssSource, /--brand-jade/);
  assert.match(cssSource, /\.brand-mark-icon/);
  assert.match(cssSource, /\.xuanwu-shield/);
  assert.match(indexHtml, /xuanwu-mark\.svg/);
  assert.match(indexHtml, /Xuanwu · Agent Guardian/);
});

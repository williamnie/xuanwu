import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const loaderSource = readFileSync(new URL('./TurtleLoader.jsx', import.meta.url), 'utf8');
const loaderStyles = readFileSync(new URL('./TurtleLoader.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const sessionSource = readFileSync(new URL('../pages/Sessions.jsx', import.meta.url), 'utf8');
const piChatSource = readFileSync(new URL('../pages/PiChat.jsx', import.meta.url), 'utf8');
const globalStyles = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

test('shared turtle loader uses the Xuanwu running asset and exposes accessible status text', () => {
  assert.match(loaderSource, /turtleAssetForState/);
  assert.match(loaderSource, /BRAND_STATES\.running/);
  assert.match(loaderSource, /role="status"/);
  assert.match(loaderSource, /aria-live="polite"/);
  assert.match(loaderSource, /turtle-loader-track/);
});

test('turtle loader and global motion classes have real keyframe animations', () => {
  assert.match(loaderStyles, /@keyframes turtle-loader-crawl/);
  assert.match(loaderStyles, /@keyframes turtle-loader-bob/);
  assert.match(loaderStyles, /prefers-reduced-motion/);
  assert.match(globalStyles, /\.animate-spin/);
  assert.match(globalStyles, /\.spin-animation/);
  assert.match(globalStyles, /\.animate-fade-in/);
  assert.match(globalStyles, /@keyframes xuanwu-spin/);
  assert.match(globalStyles, /@keyframes xuanwu-fade-in/);
});

test('primary application loading surfaces share the turtle loader', () => {
  assert.match(appSource, /<TurtleLoader/);
  assert.match(sessionSource, /<TurtleLoader/);
  assert.match(piChatSource, /<TurtleLoader/);
});

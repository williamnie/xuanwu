import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sessionsCss = readFileSync(new URL('./Sessions.css', import.meta.url), 'utf8');
const clientCss = readFileSync(new URL('./SessionsClient.css', import.meta.url), 'utf8');

function ruleFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('session transcript has shrink-safe responsive boundaries', () => {
  const contentRule = ruleFor(sessionsCss, '.session-transcript-content');
  const turnRule = ruleFor(sessionsCss, '.turn-container');
  const bubbleRule = ruleFor(sessionsCss, '.chat-bubble-container');
  const bubbleContentRule = ruleFor(sessionsCss, '.chat-bubble-content');

  assert.match(contentRule, /min-width:\s*0/);
  assert.match(contentRule, /width:\s*100%/);
  assert.match(turnRule, /min-width:\s*0/);
  assert.match(turnRule, /max-width:\s*100%/);
  assert.match(bubbleRule, /min-width:\s*0/);
  assert.match(bubbleRule, /max-width:\s*min\(100%,\s*var\(--sessions-message-max-width\)\)/);
  assert.match(bubbleContentRule, /min-width:\s*0/);
  assert.match(bubbleContentRule, /max-width:\s*100%/);
});

test('session markdown wraps long user content without overflowing small screens', () => {
  const bodyRule = ruleFor(sessionsCss, '.chat-bubble-body');
  const userBodyRule = ruleFor(sessionsCss, '.chat-bubble-container.user .chat-bubble-body');
  const markdownRule = ruleFor(sessionsCss, '.session-markdown');
  const inlineCodeRule = ruleFor(sessionsCss, '.session-markdown :not(pre) > code');
  const preCodeRule = ruleFor(sessionsCss, '.session-markdown pre code');
  const tableRule = ruleFor(sessionsCss, '.session-markdown table');

  assert.match(bodyRule, /overflow-wrap:\s*anywhere/);
  assert.match(userBodyRule, /overflow-wrap:\s*anywhere/);
  assert.match(markdownRule, /min-width:\s*0/);
  assert.match(markdownRule, /max-width:\s*100%/);
  assert.match(markdownRule, /overflow-wrap:\s*anywhere/);
  assert.match(inlineCodeRule, /white-space:\s*normal/);
  assert.match(inlineCodeRule, /overflow-wrap:\s*anywhere/);
  assert.match(preCodeRule, /white-space:\s*pre-wrap/);
  assert.match(preCodeRule, /overflow-wrap:\s*anywhere/);
  assert.match(tableRule, /max-width:\s*100%/);
  assert.match(tableRule, /overflow-x:\s*auto/);
});

test('client chat spacing uses viewport-aware padding instead of fixed desktop width', () => {
  const transcriptRule = ruleFor(clientCss, '.client-chat-area .session-transcript');
  const composerRule = ruleFor(clientCss, '.client-chat-composer-section');
  const userBubbleRule = ruleFor(sessionsCss, '.chat-bubble-container.user');

  assert.match(transcriptRule, /padding:\s*44px\s+var\(--sessions-page-gutter\)\s+24px/);
  assert.match(composerRule, /padding:\s*12px\s+var\(--sessions-page-gutter\)\s+26px/);
  assert.match(userBubbleRule, /max-width:\s*min\(100%,\s*80%\)/);
});

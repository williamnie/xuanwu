import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(new URL('./PiChat.jsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('./piChatState.js', import.meta.url), 'utf8');
const threadCss = readFileSync(new URL('./PiChatThread.css', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = threadCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('PI Assistant page does not require a project selection for global chat', () => {
  assert.doesNotMatch(pageSource, /function ProjectSelect/);
  assert.doesNotMatch(pageSource, /selectedProjectId/);
  assert.doesNotMatch(pageSource, /Project<\/span>/);
  assert.doesNotMatch(stateSource, /project_id:\s*state\.selectedProjectId/);
  assert.doesNotMatch(stateSource, /请先选择 Project/);
});

test('PI Assistant page uses assistant naming in visible chat copy', () => {
  assert.match(pageSource, /PI Assistant/);
  assert.doesNotMatch(pageSource, /Runner Brain/);
  assert.doesNotMatch(pageSource, /Runner Agent/);
  assert.doesNotMatch(pageSource, /PI Chat/);
  assert.doesNotMatch(pageSource, /PI 设置/);
});

test('PI Assistant chat renders messages as Markdown instead of raw prewrapped text', () => {
  assert.match(pageSource, /import MarkdownPreview from '\.\.\/components\/editor\/MarkdownPreview'/);
  assert.match(pageSource, /<MarkdownPreview text=\{item\.text\} className="pi-chat-markdown" \/>/);
  assert.doesNotMatch(pageSource, /pi-chat-bubble-text/);
});

test('PI Assistant chat removes the oversized hero banner in favor of compact chrome', () => {
  assert.doesNotMatch(pageSource, /function PiChatHero/);
  assert.doesNotMatch(pageSource, /pi-chat-hero/);
  assert.match(pageSource, /function PiChatSidebarHeader/);
  assert.match(pageSource, /function ChatHeader/);
});

test('PI Assistant page reuses the SessionComposer instead of a plain textarea', () => {
  assert.match(pageSource, /import SessionComposer from '\.\/sessions\/SessionComposer'/);
  assert.match(pageSource, /<SessionComposer[\s\S]*value=\{state\.prompt\}[\s\S]*onChange=\{state\.setPrompt\}/);
  assert.doesNotMatch(pageSource, /<textarea/);
  assert.doesNotMatch(pageSource, /<Send/);
});

test('PI Assistant chat reuses the session smart auto-scroll behavior', () => {
  assert.match(pageSource, /import \{ useSmartAutoScroll \} from '\.\/sessions\/smartAutoScroll'/);
  assert.match(pageSource, /useSmartAutoScroll\(\{[\s\S]*resetKey:\s*state\.selectedConversationId[\s\S]*watchKey:\s*autoScrollWatchKey[\s\S]*\}\)/);
  assert.match(pageSource, /className="pi-chat-thread" ref=\{scrollRef\} onScroll=\{handleScroll\}/);
  assert.match(pageSource, /className="pi-chat-thread-content" ref=\{contentRef\}/);
  assert.match(pageSource, /className="pi-chat-scroll-bottom-button" onClick=\{scrollToLatest\}/);
});

test('PI Assistant chat thread uses the compact session chat surface style', () => {
  const threadRule = ruleFor('.pi-chat-thread');
  const contentRule = ruleFor('.pi-chat-thread-content');
  const bubbleRule = ruleFor('.pi-chat-bubble');
  const userBubbleRule = ruleFor('.pi-chat-bubble.user');
  const assistantBubbleRule = ruleFor('.pi-chat-bubble.assistant');

  assert.match(threadRule, /padding:\s*26px\s+clamp\(12px,\s*3\.2vw,\s*40px\)/);
  assert.match(threadRule, /overscroll-behavior:\s*contain/);
  assert.match(threadRule, /scrollbar-gutter:\s*stable/);
  assert.match(contentRule, /gap:\s*18px/);
  assert.match(contentRule, /min-height:\s*100%/);
  assert.match(bubbleRule, /overflow-wrap:\s*anywhere/);
  assert.match(bubbleRule, /max-width:\s*min\(780px,\s*88%\)/);
  assert.match(userBubbleRule, /background:\s*#f3f3f6/);
  assert.match(assistantBubbleRule, /background:\s*transparent/);
});

test('PI Assistant composer supports @project activation and PI model context', () => {
  assert.match(pageSource, /buildPiChatProjectSuggestions\(state\.projects\)/);
  assert.match(pageSource, /onAttachReference=\{state\.attachReference\}/);
  assert.match(pageSource, /runtimeControls=\{<PiChatComposerMeta agent=\{state\.selectedAgent\} project=\{state\.selectedProject \|\| projectFromPrompt\(state\.prompt, state\.projects\)\} \/>\}/);
  assert.match(pageSource, /@项目后直接说需求/);
  assert.doesNotMatch(pageSource, /state\.messageSettings/);
  assert.doesNotMatch(pageSource, /state\.updateMessageSetting/);
});

test('PI Assistant chat lists all conversations instead of only active rows', () => {
  assert.match(stateSource, /api\.getPiConversations\(\)/);
  assert.doesNotMatch(stateSource, /getPiConversations\(\{\s*status:\s*'active'\s*\}\)/);
});

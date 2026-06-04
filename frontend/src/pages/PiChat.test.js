import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(new URL('./PiChat.jsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('./piChatState.js', import.meta.url), 'utf8');

test('Runner page does not require a project selection for global chat', () => {
  assert.doesNotMatch(pageSource, /function ProjectSelect/);
  assert.doesNotMatch(pageSource, /selectedProjectId/);
  assert.doesNotMatch(pageSource, /Project<\/span>/);
  assert.doesNotMatch(stateSource, /project_id:\s*state\.selectedProjectId/);
  assert.doesNotMatch(stateSource, /请先选择 Project/);
});

test('Runner page uses Runner naming in visible chat copy', () => {
  assert.match(pageSource, />Runner</);
  assert.match(pageSource, /Runner Agent/);
  assert.doesNotMatch(pageSource, /PI Chat/);
  assert.doesNotMatch(pageSource, /PI 设置/);
});

test('Runner chat renders messages as Markdown instead of raw prewrapped text', () => {
  assert.match(pageSource, /import MarkdownPreview from '\.\.\/components\/editor\/MarkdownPreview'/);
  assert.match(pageSource, /<MarkdownPreview text=\{item\.text\} className="pi-chat-markdown" \/>/);
  assert.doesNotMatch(pageSource, /pi-chat-bubble-text/);
});

test('Runner chat removes the oversized hero banner in favor of compact chrome', () => {
  assert.doesNotMatch(pageSource, /function PiChatHero/);
  assert.doesNotMatch(pageSource, /pi-chat-hero/);
  assert.match(pageSource, /function PiChatSidebarHeader/);
  assert.match(pageSource, /function ChatHeader/);
});

test('Runner page reuses the SessionComposer instead of a plain textarea', () => {
  assert.match(pageSource, /import SessionComposer from '\.\/sessions\/SessionComposer'/);
  assert.match(pageSource, /<SessionComposer[\s\S]*value=\{state\.prompt\}[\s\S]*onChange=\{state\.setPrompt\}/);
  assert.doesNotMatch(pageSource, /<textarea/);
  assert.doesNotMatch(pageSource, /<Send/);
});

test('Runner composer supports @project activation and PI model context', () => {
  assert.match(pageSource, /buildPiChatProjectSuggestions\(state\.projects\)/);
  assert.match(pageSource, /onAttachReference=\{state\.attachReference\}/);
  assert.match(pageSource, /runtimeControls=\{<PiChatComposerMeta agent=\{state\.selectedAgent\} project=\{state\.selectedProject \|\| projectFromPrompt\(state\.prompt, state\.projects\)\} \/>\}/);
  assert.match(pageSource, /@项目后直接说需求/);
  assert.doesNotMatch(pageSource, /state\.messageSettings/);
  assert.doesNotMatch(pageSource, /state\.updateMessageSetting/);
});

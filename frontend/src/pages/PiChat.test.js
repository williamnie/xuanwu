import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(new URL('./PiChat.jsx', import.meta.url), 'utf8');
const composerMetaSource = readFileSync(new URL('./PiChatComposerMeta.jsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('./piChatState.js', import.meta.url), 'utf8');
const runtimeStateSource = readFileSync(new URL('./piChatRuntimeState.js', import.meta.url), 'utf8');
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

test('Ask Xuanwu page uses canonical Chat naming in visible copy', () => {
  assert.match(pageSource, /PRODUCT_TERMS\.productLatin/);
  assert.match(pageSource, /t\('chat\.new'\)/);
  assert.match(pageSource, /t\('chat\.chats'\)/);
  assert.match(pageSource, /t\('chat\.placeholder'\)/);
  assert.doesNotMatch(pageSource, /PI Assistant/);
  assert.doesNotMatch(pageSource, /Runner Brain/);
  assert.doesNotMatch(pageSource, /Runner Agent/);
  assert.doesNotMatch(pageSource, /PI Chat/);
  assert.doesNotMatch(pageSource, /PI 设置/);
});

test('PI Assistant chat renders messages as Markdown instead of raw prewrapped text', () => {
  assert.match(pageSource, /import MarkdownPreview from '\.\.\/components\/editor\/MarkdownPreview'/);
  assert.match(pageSource, /<PiChatMessageContent advanced=\{advanced\} text=\{displayText\} \/>/);
  assert.match(pageSource, /<MarkdownPreview key=\{`markdown-\$\{index\}`\} text=\{segment\.text\} className="pi-chat-markdown" \/>/);
  assert.doesNotMatch(pageSource, /pi-chat-bubble-text/);
});

test('runner_ui_context renders as a compact custom component instead of raw XML', () => {
  assert.match(pageSource, /parsePiChatMessageContent\(text\)/);
  assert.match(pageSource, /function RunnerUiContextCard/);
  assert.match(pageSource, /t\('chat\.context\.attached'\)/);
  assert.match(pageSource, /runnerContextReferenceLabel\(reference, t\)/);
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

  assert.match(threadRule, /padding:\s*26px\s+clamp\(18px,\s*5vw,\s*72px\)\s+34px/);
  assert.match(threadRule, /overscroll-behavior:\s*contain/);
  assert.match(threadRule, /scrollbar-gutter:\s*stable/);
  assert.match(contentRule, /gap:\s*20px/);
  assert.match(contentRule, /min-height:\s*100%/);
  assert.match(bubbleRule, /overflow-wrap:\s*anywhere/);
  assert.match(bubbleRule, /max-width:\s*min\(780px,\s*88%\)/);
  assert.match(userBubbleRule, /background:\s*var\(--message-user\)/);
  assert.match(assistantBubbleRule, /background:\s*transparent/);
});

test('Chat distinguishes direct local actions from provider coding and offers practical starters', () => {
  assert.match(pageSource, /t\('chat\.capability\.direct'\)/);
  assert.match(pageSource, /t\('chat\.capability\.provider'\)/);
  assert.match(pageSource, /function filterConversations/);
  assert.match(pageSource, /t\('chat\.searchPlaceholder'\)/);
  assert.match(pageSource, /onPromptSelect=\{state\.setPrompt\}/);
  assert.match(pageSource, /chat\.starter\.\$\{kind\}\.prompt/);
});

test('PI Assistant composer supports @project activation and Advanced runtime context', () => {
  assert.match(pageSource, /buildPiChatProjectSuggestions\(state\.projects\)/);
  assert.match(pageSource, /onAttachReference=\{state\.attachReference\}/);
  assert.match(pageSource, /showReferenceChips=\{false\}/);
  assert.match(pageSource, /runtimeControls=\{<PiChatComposerMeta advanced=\{advanced\} agent=\{state\.supervisor\} project=\{composerProject\(state\)\} \/>\}/);
  assert.match(pageSource, /if \(!state\.prompt\.trim\(\)\) return null/);
  assert.match(composerMetaSource, /\{project && <RuntimePill/);
  assert.match(composerMetaSource, /if \(!project && !advanced\) return null/);
  assert.doesNotMatch(composerMetaSource, /chat\.context\.selectProject'\)/);
  assert.match(pageSource, /placeholder=\{t\('chat\.placeholder'\)\}/);
  assert.match(composerMetaSource, /\{advanced && \(/);
  assert.doesNotMatch(pageSource, /state\.messageSettings/);
  assert.doesNotMatch(pageSource, /state\.updateMessageSetting/);
});

test('PI Assistant composer exposes an active stop control while sending', () => {
  assert.match(pageSource, /const messageRunning = Boolean\(state\.sending && state\.runningConversationId\)/);
  assert.match(pageSource, /const selectedId = state\.runningConversationId \|\| state\.selectedConversationId \|\| 'runner-draft'/);
  assert.match(pageSource, /running=\{messageRunning\}/);
  assert.match(pageSource, /interruptState=\{messageRunning \? piChatInterruptState\(state, selectedId, t\) : null\}/);
  assert.match(pageSource, /onStop=\{state\.handleStop\}/);
  assert.match(pageSource, /function piChatInterruptState/);
  assert.match(stateSource, /function useStopPiMessage\(state, turnManager\)/);
  assert.match(stateSource, /assistantApi\.interruptPiConversation\(conversationId\)/);
});

test('PI Assistant chat lists all conversations instead of only active rows', () => {
  assert.match(stateSource, /assistantApi\.getPiConversations\(\)/);
  assert.doesNotMatch(stateSource, /getPiConversations\(\{\s*status:\s*'active'\s*\}\)/);
});

test('PI Assistant sidebar exposes runtime state and activity timestamps', () => {
  assert.match(pageSource, /conversation\.runtime_status === 'running'/);
  assert.match(pageSource, /className="pi-chat-conversation-runtime"/);
  assert.match(pageSource, /conversation\.last_activity_at \|\| conversation\.updated_at/);
  assert.match(pageSource, /t\('chat\.status\.idle'\)/);
});

test('Chat hides runtime internals by default and exposes diagnostics only through Advanced', () => {
  assert.match(pageSource, /const \[advanced, setAdvanced\] = useState\(false\)/);
  assert.match(pageSource, /aria-pressed=\{advanced\}/);
  assert.match(pageSource, /\{advanced && \(\s*<button[\s\S]*t\('chat\.copyConversationDebug'\)/);
  assert.match(pageSource, /\{advanced && <small>\{shortId\(conversation\.pi_session_id \|\| conversation\.id\)\}<\/small>\}/);
  assert.match(pageSource, /\{advanced && \(conversationId \|\| sessionId\) && \(/);
  assert.match(pageSource, /advanced \? advancedAgentLabel\(agent, t\)/);
  assert.match(composerMetaSource, /t\('chat\.context\.modelHint'\)/);
  assert.match(pageSource, /formatPiConversationDebugInfo/);
  assert.match(pageSource, /formatPiMessageDebugInfo/);
  assert.match(pageSource, /title=\{advanced \? t\('chat\.copyMessageDebugHint'\) : undefined\}/);
  assert.match(runtimeStateSource, /created_at:\s*item\.created_at \|\| ''/);
});

test('Chat renders user status, canonical Work links, and actionable empty and error states', () => {
  assert.match(pageSource, /piChatStatusSummary\(\{[\s\S]*conversation: state\.selectedConversation,[\s\S]*transcript: state\.transcript/);
  assert.match(pageSource, /piChatWorkLinks\(transcript\)/);
  assert.match(pageSource, /navigateTo\('work', work\.id\)/);
  assert.match(pageSource, /navigateTo\('work'\)/);
  assert.match(pageSource, /t\('chat\.unavailable'\)/);
  assert.match(pageSource, /onClick=\{onRetry\}/);
  assert.match(pageSource, /t\('chat\.start'\)/);
  assert.match(pageSource, /t\('chat\.startDescription'\)/);
  assert.match(pageSource, /\{advanced && <code>\{error\}<\/code>\}/);
  assert.match(pageSource, /item\.role === 'error' && !advanced/);
  assert.match(pageSource, /t\('chat\.turnIncomplete'\)/);
});

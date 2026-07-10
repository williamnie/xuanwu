import { Bot, ChevronDown, Copy, Loader2, MessageSquarePlus, RefreshCw, Settings2 } from 'lucide-react';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import TurtleLoader from '../components/TurtleLoader';
import SessionComposer from './sessions/SessionComposer';
import PiChatComposerMeta from './PiChatComposerMeta';
import { buildPiChatProjectSuggestions, buildPiChatReferenceDetails } from './piChatComposer';
import { copyPiDebugText, formatPiConversationDebugInfo, formatPiMessageDebugInfo } from './piChatDiagnostics';
import { projectFromPrompt } from './piChatProjectContext';
import { shortId, usePiChatState } from './piChatState';
import { useSmartAutoScroll } from './sessions/smartAutoScroll';
import './PiChat.css';
import './PiChatDiagnostics.css';
import './PiChatSidebar.css';
import './PiChatThread.css';

export default function PiChat({ navigateTo }) {
  const state = usePiChatState();
  return <PiChatLayout navigateTo={navigateTo} state={state} />;
}

function PiChatLayout({ navigateTo, state }) {
  return (
    <div className="pi-chat-page animate-fade-in">
      <section className="pi-chat-shell">
        <PiChatSidebar navigateTo={navigateTo} state={state} />
        <PiChatMain navigateTo={navigateTo} state={state} />
      </section>
    </div>
  );
}

function PiChatSidebar({ navigateTo, state }) {
  return (
    <aside className="pi-chat-sidebar glass-card">
      <PiChatSidebarHeader
        loading={state.loading}
        navigateTo={navigateTo}
        onRefresh={state.loadPiState}
      />
      <AgentStatus agent={state.selectedAgent} />
      <button className="btn btn-primary" onClick={state.handleCreateConversation} disabled={state.sending}>
        <MessageSquarePlus size={15} /> 新建 Assistant 会话
      </button>
      <ConversationList
        conversations={state.conversations}
        selectedId={state.selectedConversationId}
        onSelect={state.handleConversationChange}
      />
    </aside>
  );
}

function PiChatSidebarHeader({ loading, navigateTo, onRefresh }) {
  return (
    <div className="pi-chat-sidebar-header">
      <div className="pi-chat-sidebar-brand">
        <span className="pi-chat-sidebar-icon"><Bot size={16} /></span>
        <div>
          <strong>PI Assistant</strong>
          <span>Single runtime</span>
        </div>
      </div>
      <div className="pi-chat-sidebar-actions">
        <button className="pi-chat-icon-button" onClick={onRefresh} disabled={loading} title="刷新 Assistant 会话">
          <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
        </button>
        <button className="pi-chat-icon-button" onClick={() => navigateTo('settings')} title="Assistant Settings">
          <Settings2 size={15} />
        </button>
      </div>
    </div>
  );
}

function PiChatMain({ navigateTo, state }) {
  return (
    <main className="pi-chat-main glass-card">
      {state.error && <div className="pi-chat-error">{state.error}</div>}
      {!state.error && state.loading ? <LoadingState /> : (
        <>
          <ChatHeader state={state} />
          <ChatThread navigateTo={navigateTo} state={state} />
          <ChatComposer state={state} />
        </>
      )}
    </main>
  );
}

function ChatHeader({ state }) {
  const title = state.selectedConversation?.title || 'New conversation';
  const count = state.transcript.length;
  return (
    <header
      className="pi-chat-main-header"
      onContextMenu={(event) => copyConversationDebugInfo(event, state.selectedConversation)}
      title="右键复制当前 Assistant 会话诊断信息"
    >
      <div>
        <span>PI Assistant</span>
        <strong>{title}</strong>
      </div>
      <div className="pi-chat-header-actions">
        <small>{count} message{count === 1 ? '' : 's'}</small>
        <button
          aria-label="复制当前会话诊断信息"
          className="pi-chat-copy-button"
          disabled={!state.selectedConversation}
          onClick={() => copyConversationDebugInfo(null, state.selectedConversation)}
          title="复制当前会话诊断信息"
          type="button"
        >
          <Copy size={13} />
        </button>
      </div>
    </header>
  );
}

function ConversationList({ conversations, onSelect, selectedId }) {
  return (
    <div className="pi-chat-conversation-list">
      <div className="pi-chat-sidebar-title">Conversations</div>
      {conversations.length === 0 ? <div className="pi-chat-empty-mini">暂无 Assistant 会话</div> : (
        conversations.map((conversation) => (
          <button
            key={conversation.id}
            className={`pi-chat-conversation ${selectedId === conversation.id ? 'active' : ''}`}
            onClick={() => onSelect(conversation.id)}
            onContextMenu={(event) => copyConversationDebugInfo(event, conversation)}
            title="右键复制 Assistant 会话诊断信息"
          >
            <span>{conversation.title || conversation.id}</span>
            <small>{shortId(conversation.pi_session_id || conversation.id)}</small>
          </button>
        ))
      )}
    </div>
  );
}

function ChatThread({ navigateTo, state }) {
  const lastMessage = state.transcript[state.transcript.length - 1];
  const autoScrollWatchKey = [
    state.transcript.length,
    lastMessage?.id || '',
    lastMessage?.text || '',
    state.sending ? 'sending' : 'idle',
  ].join(':');
  const {
    scrollRef,
    contentRef,
    showScrollButton,
    handleScroll,
    scrollToLatest,
  } = useSmartAutoScroll({
    resetKey: state.selectedConversationId,
    watchKey: autoScrollWatchKey,
  });
  return (
    <div className="pi-chat-thread-frame">
      <div className="pi-chat-thread" ref={scrollRef} onScroll={handleScroll}>
        <div className="pi-chat-thread-content" ref={contentRef}>
          {state.transcript.length === 0 ? (
            <EmptyChat navigateTo={navigateTo} hasRuntime={state.agents.length > 0} />
          ) : state.transcript.map((item) => (
            <ChatBubble key={item.id} conversation={state.selectedConversation} item={item} />
          ))}
          {state.sending && <div className="pi-chat-thinking"><Loader2 className="spin-animation" size={14} /> PI Assistant 正在思考...</div>}
        </div>
      </div>
      {showScrollButton && (
        <button type="button" className="pi-chat-scroll-bottom-button" onClick={scrollToLatest}>
          <ChevronDown size={14} />
          回到底部
        </button>
      )}
    </div>
  );
}

const PI_CHAT_COMPOSER_SETTINGS = { model: '', reasoningEffort: '', approvalPolicy: 'never', sandbox: 'workspace-write' };

function ChatComposer({ state }) {
  const messageRunning = Boolean(state.sending && state.runningConversationId);
  const selectedId = state.runningConversationId || state.selectedConversationId || 'runner-draft';
  return (
    <div className="pi-chat-composer">
      <SessionComposer
        value={state.prompt}
        onChange={state.setPrompt}
        settings={PI_CHAT_COMPOSER_SETTINGS}
        onSettingChange={() => {}}
        models={[]}
        modelsLoading={false}
        modelsError=""
        sending={state.sending}
        running={messageRunning}
        interruptState={messageRunning ? piChatInterruptState(state, selectedId) : null}
        selectedId={selectedId}
        placeholder="@项目后直接说需求，例如：@codex-issue-runner 创建一个 issue，修复 Assistant 输入体验..."
        onSubmit={state.handleSend}
        suggestions={buildPiChatProjectSuggestions(state.projects)}
        referenceDetails={buildPiChatReferenceDetails(state.references, state.projects)}
        onAttachReference={state.attachReference}
        onRemoveReference={state.removeReference}
        runtimeControls={<PiChatComposerMeta agent={state.selectedAgent} project={state.selectedProject || projectFromPrompt(state.prompt, state.projects)} />}
        onStop={state.handleStop}
      />
    </div>
  );
}

function piChatInterruptState(state, selectedId) {
  if (!state.stopping) return null;
  return {
    sessionId: selectedId,
    status: 'pending',
    text: '正在停止 PI Assistant...',
    tone: 'info'
  };
}

function AgentStatus({ agent }) {
  if (!agent) return <div className="pi-chat-agent-status warning">未配置可用 PI Assistant runtime</div>;
  return (
    <div className="pi-chat-agent-status">
      <Bot size={14} />
      <div>
        <strong>{agent.model_provider || 'provider 未设'}</strong>
        <span>{agent.model_id || 'model 未设'} · {agent.enabled ? 'enabled' : 'disabled'}</span>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="pi-chat-empty">
      <TurtleLoader label="玄武正在连接 Assistant…" />
    </div>
  );
}

function EmptyChat({ hasRuntime, navigateTo }) {
  return (
    <div className="pi-chat-empty">
      <Bot size={34} />
      <strong>{hasRuntime ? '开始一次 Assistant 对话' : '先配置 PI Assistant'}</strong>
      <span>{hasRuntime ? '输入 @ 选择项目，然后自然语言告诉 PI 要创建/梳理什么 issue。' : 'Assistant Settings 里填写 provider、API path、API key 和模型后即可聊天。'}</span>
      {!hasRuntime && <button className="btn btn-secondary" onClick={() => navigateTo('settings')}>打开 Assistant Settings</button>}
    </div>
  );
}

function ChatBubble({ conversation, item }) {
  const copyDebugInfo = () => copyMessageDebugInfo(null, item, conversation);
  const conversationId = item.meta?.conversation_id || conversation?.id || '';
  const sessionId = item.meta?.pi_session_id || conversation?.pi_session_id || '';
  return (
    <article
      className={`pi-chat-bubble ${item.role}`}
      onContextMenu={(event) => copyMessageDebugInfo(event, item, conversation)}
      title="右键复制消息诊断信息"
    >
      <div className="pi-chat-bubble-role">{item.role === 'assistant' ? 'PI Assistant' : item.role === 'error' ? 'Error' : 'You'}</div>
      <MarkdownPreview text={item.text} className="pi-chat-markdown" />
      {(conversationId || sessionId) && (
        <div className="pi-chat-bubble-meta">
          <span>{piBubbleMetaLabel(conversationId, sessionId)}</span>
          <button aria-label="复制消息诊断信息" onClick={copyDebugInfo} title="复制消息诊断信息" type="button">
            <Copy size={11} />
          </button>
        </div>
      )}
    </article>
  );
}

function piBubbleMetaLabel(conversationId, sessionId) {
  if (!conversationId) return `session ${shortId(sessionId)}`;
  if (!sessionId || sessionId === conversationId) return `chat ${shortId(conversationId || sessionId)}`;
  return `chat ${shortId(conversationId)} · session ${shortId(sessionId)}`;
}

function copyConversationDebugInfo(event, conversation) {
  if (!conversation) return;
  event?.preventDefault();
  copyPiDebugText(formatPiConversationDebugInfo(conversation), '已复制 Assistant 会话诊断信息');
}

function copyMessageDebugInfo(event, item, conversation) {
  event?.preventDefault();
  copyPiDebugText(formatPiMessageDebugInfo(item, conversation), '已复制 Assistant 消息诊断信息');
}

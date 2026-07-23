import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  Copy,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { PRODUCT_NAV_LABELS, PRODUCT_TERMS } from '../brand';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import TurtleLoader from '../components/TurtleLoader';
import SessionComposer from './sessions/SessionComposer';
import PiChatComposerMeta from './PiChatComposerMeta';
import { buildPiChatProjectSuggestions, buildPiChatReferenceDetails } from './piChatComposer';
import { copyPiDebugText, formatPiConversationDebugInfo, formatPiMessageDebugInfo } from './piChatDiagnostics';
import { projectFromPrompt } from './piChatProjectContext';
import {
  parsePiChatMessageContent,
  runnerContextModeLabel,
  runnerContextReferenceLabel,
} from './piChatMessageContent';
import { displayPiConversationTitle, piChatStatusSummary, piChatWorkLinks } from './piChatPresentation';
import { shortId, usePiChatState } from './piChatState';
import { useSmartAutoScroll } from './sessions/smartAutoScroll';
import './PiChat.css';
import './PiChatDiagnostics.css';
import './PiChatSidebar.css';
import './PiChatThread.css';

export default function PiChat({ navigateTo, initialConversationId = '' }) {
  const state = usePiChatState(initialConversationId);
  const [advanced, setAdvanced] = useState(false);
  return <PiChatLayout advanced={advanced} navigateTo={navigateTo} setAdvanced={setAdvanced} state={state} />;
}

function PiChatLayout({ advanced, navigateTo, setAdvanced, state }) {
  return (
    <div className="pi-chat-page animate-fade-in">
      <section className="pi-chat-shell">
        <PiChatSidebar advanced={advanced} navigateTo={navigateTo} state={state} />
        <PiChatMain advanced={advanced} navigateTo={navigateTo} setAdvanced={setAdvanced} state={state} />
      </section>
    </div>
  );
}

function PiChatSidebar({ advanced, navigateTo, state }) {
  return (
    <aside className="pi-chat-sidebar glass-card">
      <PiChatSidebarHeader
        loading={state.loading}
        navigateTo={navigateTo}
        onRefresh={state.loadPiState}
      />
      <AgentStatus advanced={advanced} agent={state.supervisor} />
      <button className="btn btn-primary" onClick={state.handleCreateConversation} disabled={state.sending}>
        <MessageSquarePlus size={15} /> 新建 Chat
      </button>
      <ConversationList
        advanced={advanced}
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
          <strong>{PRODUCT_NAV_LABELS.askXuanwu}</strong>
          <span>Chat</span>
        </div>
      </div>
      <div className="pi-chat-sidebar-actions">
        <button className="pi-chat-icon-button" onClick={onRefresh} disabled={loading} title="刷新 Chat">
          <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
        </button>
        <button className="pi-chat-icon-button" onClick={() => navigateTo('connections')} title="打开 Connections">
          <Settings2 size={15} />
        </button>
      </div>
    </div>
  );
}

function PiChatMain({ advanced, navigateTo, setAdvanced, state }) {
  return (
    <main className="pi-chat-main glass-card">
      {state.error ? (
        <ChatErrorState
          advanced={advanced}
          error={state.error}
          navigateTo={navigateTo}
          onAdvancedChange={setAdvanced}
          onRetry={state.loadPiState}
        />
      ) : state.loading ? <LoadingState /> : (
        <>
          <ChatHeader advanced={advanced} onAdvancedChange={setAdvanced} state={state} />
          <ChatContextBar navigateTo={navigateTo} transcript={state.transcript} />
          <ChatThread advanced={advanced} navigateTo={navigateTo} state={state} />
          <ChatComposer advanced={advanced} state={state} />
        </>
      )}
    </main>
  );
}

function ChatHeader({ advanced, onAdvancedChange, state }) {
  const title = displayPiConversationTitle(state.selectedConversation);
  const summary = piChatStatusSummary({
    conversation: state.selectedConversation,
    error: state.error,
    loading: state.loading,
    sending: state.sending,
    transcript: state.transcript,
  });
  return (
    <header
      className="pi-chat-main-header"
      onContextMenu={advanced ? (event) => copyConversationDebugInfo(event, state.selectedConversation) : undefined}
      title={advanced ? '右键复制当前 Chat 诊断信息' : undefined}
    >
      <div className="pi-chat-title-group">
        <span>Chat</span>
        <strong>{title}</strong>
      </div>
      <div className="pi-chat-header-actions">
        <ChatStatusSummary summary={summary} />
        <button
          aria-pressed={advanced}
          className={`pi-chat-advanced-toggle ${advanced ? 'active' : ''}`}
          onClick={() => onAdvancedChange(value => !value)}
          title="切换模型、runtime ID 与复制诊断信息"
          type="button"
        >
          <SlidersHorizontal size={13} /> Advanced
        </button>
        {advanced && (
          <button
            aria-label="复制当前 Chat 诊断信息"
            className="pi-chat-copy-button"
            disabled={!state.selectedConversation}
            onClick={() => copyConversationDebugInfo(null, state.selectedConversation)}
            title="复制当前 Chat 诊断信息"
            type="button"
          >
            <Copy size={13} />
          </button>
        )}
      </div>
    </header>
  );
}

function ChatStatusSummary({ summary }) {
  return (
    <div className="pi-chat-status-summary" data-tone={summary.tone} role="status">
      <span className="pi-chat-status-dot" />
      <span className="pi-chat-status-copy">
        <span>{summary.label}</span>
        <small>{summary.detail}</small>
      </span>
    </div>
  );
}

function ChatContextBar({ navigateTo, transcript }) {
  const workLinks = piChatWorkLinks(transcript);
  return (
    <nav className="pi-chat-context-bar" aria-label="Chat 关联 Work">
      <span><BriefcaseBusiness size={13} /> Work</span>
      {workLinks.map((work) => (
        <button key={work.id} onClick={() => navigateTo('work', work.id)} type="button">
          {work.label} <ArrowUpRight size={11} />
        </button>
      ))}
      <button className="pi-chat-all-work-link" onClick={() => navigateTo('work')} type="button">
        {workLinks.length > 0 ? '查看全部' : '打开 Work'} <ArrowUpRight size={11} />
      </button>
    </nav>
  );
}

function ConversationList({ advanced, conversations, onSelect, selectedId }) {
  return (
    <div className="pi-chat-conversation-list">
      <div className="pi-chat-sidebar-title">Chats</div>
      {conversations.length === 0 ? (
        <div className="pi-chat-empty-mini">暂无 Chat。点击上方按钮开始。</div>
      ) : (
        conversations.map((conversation) => (
          <button
            key={conversation.id}
            className={`pi-chat-conversation ${selectedId === conversation.id ? 'active' : ''}`}
            onClick={() => onSelect(conversation.id)}
            onContextMenu={advanced ? (event) => copyConversationDebugInfo(event, conversation) : undefined}
            title={advanced ? '右键复制 Chat 诊断信息' : undefined}
          >
            <span>{displayPiConversationTitle(conversation)}</span>
            {advanced && <small>{shortId(conversation.pi_session_id || conversation.id)}</small>}
          </button>
        ))
      )}
    </div>
  );
}

function ChatThread({ advanced, navigateTo, state }) {
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
            <EmptyChat navigateTo={navigateTo} hasRuntime={Boolean(state.supervisor)} />
          ) : state.transcript.map((item) => (
            <ChatBubble advanced={advanced} key={item.id} conversation={state.selectedConversation} item={item} />
          ))}
          {state.sending && <div className="pi-chat-thinking"><Loader2 className="spin-animation" size={14} /> Xuanwu 正在处理...</div>}
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

function ChatComposer({ advanced, state }) {
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
        placeholder="Ask Xuanwu… @项目后描述目标、进展或期望交付"
        onSubmit={state.handleSend}
        suggestions={buildPiChatProjectSuggestions(state.projects)}
        referenceDetails={buildPiChatReferenceDetails(state.references, state.projects)}
        onAttachReference={state.attachReference}
        onRemoveReference={state.removeReference}
        runtimeControls={<PiChatComposerMeta advanced={advanced} agent={state.supervisor} project={state.selectedProject || projectFromPrompt(state.prompt, state.projects)} />}
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
    text: '正在停止 Xuanwu...',
    tone: 'info'
  };
}

function AgentStatus({ advanced, agent }) {
  if (!agent) {
    return (
      <div className="pi-chat-agent-status warning">
        <AlertTriangle size={14} />
        <div>
          <strong>Xuanwu 还未连接</strong>
          <span>请在 Connections 完成配置</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`pi-chat-agent-status ${agent.enabled ? '' : 'warning'}`}>
      {agent.enabled ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      <div>
        <strong>{agent.enabled ? 'Xuanwu 已连接' : 'Xuanwu 暂不可用'}</strong>
        <span>{advanced ? advancedAgentLabel(agent) : agent.enabled ? '可以开始对话' : '请在 Connections 检查配置'}</span>
      </div>
    </div>
  );
}

function advancedAgentLabel(agent) {
  const provider = agent.model_provider || 'provider 未设';
  const model = agent.model_id || 'model 未设';
  return `${provider} / ${model} · ${shortId(agent.id)}`;
}

function LoadingState() {
  return (
    <div className="pi-chat-empty">
      <TurtleLoader label="正在载入 Chat…" />
    </div>
  );
}

function ChatErrorState({ advanced, error, navigateTo, onAdvancedChange, onRetry }) {
  return (
    <div className="pi-chat-empty pi-chat-error" role="alert">
      <AlertTriangle size={34} />
      <strong>Chat 暂不可用</strong>
      <span>暂时无法读取对话记录。请重试；若问题持续，再到 Advanced 查看诊断。</span>
      {advanced && <code>{error}</code>}
      <div className="pi-chat-empty-actions">
        <button className="btn btn-primary" onClick={onRetry} type="button"><RefreshCw size={14} /> 重试</button>
        <button
          aria-pressed={advanced}
          className="btn btn-secondary"
          onClick={() => onAdvancedChange(value => !value)}
          type="button"
        >
          <SlidersHorizontal size={14} /> Advanced
        </button>
        <button className="btn btn-secondary" onClick={() => navigateTo('connections')} type="button">打开 Connections</button>
      </div>
    </div>
  );
}

function EmptyChat({ hasRuntime, navigateTo }) {
  return (
    <div className="pi-chat-empty">
      <Bot size={34} />
      <strong>{hasRuntime ? '开始新的 Chat' : 'Xuanwu 还未连接'}</strong>
      <span>{hasRuntime ? '说明你的目标、约束和期望交付；进展、证据与 Work 会留在这里。' : '请在 Connections 完成 Xuanwu 配置后再开始对话。'}</span>
      {!hasRuntime && <button className="btn btn-secondary" onClick={() => navigateTo('connections')}>打开 Connections</button>}
    </div>
  );
}

function ChatBubble({ advanced, conversation, item }) {
  const copyDebugInfo = () => copyMessageDebugInfo(null, item, conversation);
  const conversationId = item.meta?.conversation_id || conversation?.id || '';
  const sessionId = item.meta?.pi_session_id || conversation?.pi_session_id || '';
  const displayText = item.role === 'error' && !advanced
    ? '此轮未完成。请重试；若问题持续，可在 Advanced 查看诊断。'
    : item.text;
  const assistant = item.role === 'assistant';
  const error = item.role === 'error';
  return (
    <article
      className={`pi-chat-bubble ${item.role}`}
      onContextMenu={advanced ? (event) => copyMessageDebugInfo(event, item, conversation) : undefined}
      title={advanced ? '右键复制消息诊断信息' : undefined}
    >
      <header className="pi-chat-bubble-header">
        <span className="pi-chat-bubble-avatar" aria-hidden="true">
          {assistant ? <Bot size={15} /> : error ? <AlertTriangle size={15} /> : <UserRound size={15} />}
        </span>
        <span className="pi-chat-bubble-role">{assistant ? PRODUCT_TERMS.productLatin : error ? '未完成' : '你'}</span>
      </header>
      <div className="pi-chat-bubble-content">
        <PiChatMessageContent advanced={advanced} text={displayText} />
      </div>
      {advanced && (conversationId || sessionId) && (
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

function PiChatMessageContent({ advanced, text }) {
  return parsePiChatMessageContent(text).map((segment, index) => {
    if (segment.type === 'runner_ui_context') {
      return <RunnerUiContextCard advanced={advanced} context={segment.context} key={`context-${index}`} />;
    }
    return <MarkdownPreview key={`markdown-${index}`} text={segment.text} className="pi-chat-markdown" />;
  });
}

function RunnerUiContextCard({ advanced, context }) {
  const mode = context.fields.permission_mode || '';
  const references = context.references || [];
  return (
    <section className="pi-chat-context-card" aria-label="Runner 页面上下文">
      <div className="pi-chat-context-card-icon"><ShieldCheck size={16} /></div>
      <div className="pi-chat-context-card-copy">
        <div className="pi-chat-context-card-title">
          <strong>已附带 Runner 上下文</strong>
          <span data-mode={mode}>{runnerContextModeLabel(mode)}</span>
        </div>
        <p>{mode === 'read_only' ? 'Xuanwu 只会读取当前页面信息。' : 'Xuanwu 可以识别当前页面，但操作仍受运行时门禁约束。'}</p>
        {references.length > 0 && (
          <div className="pi-chat-context-card-references">
            {references.map((reference, index) => <span key={`${reference.type}-${index}`}>{runnerContextReferenceLabel(reference)}</span>)}
          </div>
        )}
        {advanced && <RunnerUiContextDetails context={context} />}
      </div>
    </section>
  );
}

function RunnerUiContextDetails({ context }) {
  return (
    <details className="pi-chat-context-card-details">
      <summary>技术上下文</summary>
      <dl>
        {Object.entries(context.fields).map(([key, value]) => (
          <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </details>
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
  copyPiDebugText(formatPiConversationDebugInfo(conversation), '已复制 Chat 诊断信息');
}

function copyMessageDebugInfo(event, item, conversation) {
  event?.preventDefault();
  copyPiDebugText(formatPiMessageDebugInfo(item, conversation), '已复制 Chat 消息诊断信息');
}

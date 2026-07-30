import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  Code2,
  Copy,
  FolderGit2,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { PRODUCT_TERMS } from '../brand';
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
import { displayPiConversationTitle, piChatStatusSummary, piChatWorkLinks, visiblePiConversations } from './piChatPresentation';
import { shortId, usePiChatState } from './piChatState';
import { useSmartAutoScroll } from './sessions/smartAutoScroll';
import './PiChat.css';
import './PiChatDiagnostics.css';
import './PiChatSidebar.css';
import './PiChatThread.css';
import { useI18n } from '../i18n/context.js';

export default function PiChat({ navigateTo, initialConversationId = '', onConversationChange = null }) {
  const state = usePiChatState(initialConversationId, onConversationChange);
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
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const conversations = filterConversations(visiblePiConversations(state.conversations), query, t);
  return (
    <aside className="pi-chat-sidebar glass-card">
      <PiChatSidebarHeader
        loading={state.loading}
        navigateTo={navigateTo}
        onRefresh={state.loadPiState}
      />
      <AgentStatus advanced={advanced} agent={state.supervisor} />
      <button className="btn btn-primary" onClick={state.handleCreateConversation} disabled={state.sending}>
        <MessageSquarePlus size={15} /> {t('chat.new')}
      </button>
      <label className="pi-chat-conversation-search">
        <Search size={14} aria-hidden="true" />
        <input
          aria-label={t('chat.search')}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('chat.searchPlaceholder')}
          type="search"
          value={query}
        />
      </label>
      <ConversationList
        advanced={advanced}
        conversations={conversations}
        emptyLabel={query ? t('chat.noSearchResults') : t('chat.emptyList')}
        selectedId={state.selectedConversationId}
        unreadIds={state.unreadConversationIds}
        onSelect={state.handleConversationChange}
      />
    </aside>
  );
}

function PiChatSidebarHeader({ loading, navigateTo, onRefresh }) {
  const { t } = useI18n();
  return (
    <div className="pi-chat-sidebar-header">
      <div className="pi-chat-sidebar-brand">
        <span className="pi-chat-sidebar-icon"><Bot size={16} /></span>
        <div>
          <strong>{t('nav.askXuanwu')}</strong>
          <span>{t('chat.chat')}</span>
        </div>
      </div>
      <div className="pi-chat-sidebar-actions">
        <button className="pi-chat-icon-button" onClick={onRefresh} disabled={loading} title={t('chat.refresh')}>
          <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
        </button>
        <button className="pi-chat-icon-button" onClick={() => navigateTo('connections')} title={t('chat.openConnections')}>
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
          <ChatContextBar navigateTo={navigateTo} project={state.selectedProject} transcript={state.transcript} />
          <ChatThread advanced={advanced} navigateTo={navigateTo} state={state} />
          <ChatComposer advanced={advanced} state={state} />
        </>
      )}
    </main>
  );
}

function ChatHeader({ advanced, onAdvancedChange, state }) {
  const { t } = useI18n();
  const title = displayPiConversationTitle(state.selectedConversation, t);
  const summary = piChatStatusSummary({
    conversation: state.selectedConversation,
    error: state.error,
    loading: state.loading,
    sending: state.sending,
    t,
    transcript: state.transcript,
  });
  return (
    <header
      className="pi-chat-main-header"
      onContextMenu={advanced ? (event) => copyConversationDebugInfo(event, state.selectedConversation, t('chat.debugCopied')) : undefined}
      title={advanced ? t('chat.copyConversationDebugHint') : undefined}
    >
      <div className="pi-chat-title-group">
        <span>{t('chat.chat')}</span>
        <strong>{title}</strong>
      </div>
      <div className="pi-chat-header-actions">
        <ChatStatusSummary summary={summary} />
        <button
          aria-pressed={advanced}
          className={`pi-chat-advanced-toggle ${advanced ? 'active' : ''}`}
          onClick={() => onAdvancedChange(value => !value)}
          title={t('chat.advancedHint')}
          type="button"
        >
          <SlidersHorizontal size={13} /> {t('settings.advanced')}
        </button>
        {advanced && (
          <button
            aria-label={t('chat.copyConversationDebug')}
            className="pi-chat-copy-button"
            disabled={!state.selectedConversation}
            onClick={() => copyConversationDebugInfo(null, state.selectedConversation, t('chat.debugCopied'))}
            title={t('chat.copyConversationDebug')}
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

function ChatContextBar({ navigateTo, project, transcript }) {
  const { t } = useI18n();
  const workLinks = piChatWorkLinks(transcript);
  return (
    <nav className="pi-chat-context-bar" aria-label={t('chat.capabilities')}>
      <span className="pi-chat-capability direct"><Sparkles size={13} /> {t('chat.capability.direct')}</span>
      <span className="pi-chat-capability provider"><Code2 size={13} /> {t('chat.capability.provider')}</span>
      {project && <span className="pi-chat-capability project"><FolderGit2 size={13} /> @{project.name || project.id}</span>}
      {workLinks.length > 0 && (
        <span className="pi-chat-work-links">
          <span><BriefcaseBusiness size={13} /> Work</span>
          {workLinks.map((work) => (
            <button key={work.id} onClick={() => navigateTo('work', work.id)} type="button">
              {work.label} <ArrowUpRight size={11} />
            </button>
          ))}
          <button className="pi-chat-all-work-link" onClick={() => navigateTo('work')} type="button">
            {t('chat.viewAll')} <ArrowUpRight size={11} />
          </button>
        </span>
      )}
    </nav>
  );
}

function ConversationList({ advanced, conversations, emptyLabel, onSelect, selectedId, unreadIds }) {
  const { language, t } = useI18n();
  return (
    <div className="pi-chat-conversation-list">
      <div className="pi-chat-sidebar-title">{t('chat.chats')}</div>
      {conversations.length === 0 ? (
        <div className="pi-chat-empty-mini">{emptyLabel}</div>
      ) : (
        conversations.map((conversation) => {
          const runtime = conversationRuntimePresentation(conversation, unreadIds.has(conversation.id), t);
          return (
            <button
              key={conversation.id}
              className={`pi-chat-conversation ${selectedId === conversation.id ? 'active' : ''} ${runtime?.tone || ''}`}
              onClick={() => onSelect(conversation.id)}
              onContextMenu={advanced ? (event) => copyConversationDebugInfo(event, conversation, t('chat.debugCopied')) : undefined}
              title={advanced ? t('chat.copyChatDebugHint') : undefined}
            >
              <span className="pi-chat-conversation-heading">
                <span className="pi-chat-conversation-title">{displayPiConversationTitle(conversation, t)}</span>
                {runtime && (
                  <span
                    aria-label={runtime.label}
                    className="pi-chat-conversation-runtime"
                    data-tone={runtime.tone}
                    role="status"
                    title={runtime.label}
                  >
                    <span aria-hidden="true" />
                  </span>
                )}
              </span>
              <span className="pi-chat-conversation-meta">
                <span>{formatConversationDate(conversation.last_activity_at || conversation.updated_at || conversation.created_at, language)}</span>
                <span>{conversation.project_id ? `@${conversation.project_id}` : t('chat.global')}</span>
              </span>
              {advanced && <small>{shortId(conversation.pi_session_id || conversation.id)}</small>}
            </button>
          );
        })
      )}
    </div>
  );
}

function ChatThread({ advanced, navigateTo, state }) {
  const { t } = useI18n();
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
    forceScrollKey: lastMessage?.role === 'user' ? lastMessage.id : '',
    resetKey: state.selectedConversationId,
    watchKey: autoScrollWatchKey,
  });
  return (
    <div className="pi-chat-thread-frame">
      <div className="pi-chat-thread" ref={scrollRef} onScroll={handleScroll}>
        <div className="pi-chat-thread-content" ref={contentRef}>
          {state.transcript.length === 0 ? (
            <EmptyChat
              navigateTo={navigateTo}
              hasRuntime={Boolean(state.supervisor)}
              onPromptSelect={state.setPrompt}
            />
          ) : state.transcript.map((item) => (
            <ChatBubble advanced={advanced} key={item.id} conversation={state.selectedConversation} item={item} />
          ))}
          {state.sending && (
            <div className="pi-chat-thinking" role="status">
              <span className="pi-chat-thinking-signal" aria-hidden="true" />
              <span className="pi-chat-thinking-kicker">RUNNING</span>
              <span>{t('chat.processing')}</span>
            </div>
          )}
        </div>
      </div>
      {showScrollButton && (
        <button type="button" className="pi-chat-scroll-bottom-button" onClick={scrollToLatest}>
          <ChevronDown size={14} />
          {t('chat.backToBottom')}
        </button>
      )}
    </div>
  );
}

const PI_CHAT_COMPOSER_SETTINGS = { model: '', reasoningEffort: '', approvalPolicy: 'never', sandbox: 'workspace-write' };

function ChatComposer({ advanced, state }) {
  const { t } = useI18n();
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
        interruptState={messageRunning ? piChatInterruptState(state, selectedId, t) : null}
        selectedId={selectedId}
        placeholder={t('chat.placeholder')}
        onSubmit={state.handleSend}
        suggestions={buildPiChatProjectSuggestions(state.projects)}
        referenceDetails={buildPiChatReferenceDetails(state.references, state.projects)}
        showReferenceChips={false}
        onAttachReference={state.attachReference}
        onRemoveReference={state.removeReference}
        runtimeControls={<PiChatComposerMeta advanced={advanced} agent={state.supervisor} project={composerProject(state)} />}
        onStop={state.handleStop}
      />
    </div>
  );
}

function composerProject(state) {
  const hasProjectReference = state.references.some((reference) => reference.type === 'project');
  if (hasProjectReference) return state.selectedProject;
  if (!state.prompt.trim()) return null;
  return projectFromPrompt(state.prompt, state.projects);
}

function piChatInterruptState(state, selectedId, t) {
  if (!state.stopping) return null;
  return {
    sessionId: selectedId,
    status: 'pending',
    text: t('chat.stopping'),
    tone: 'info'
  };
}

function AgentStatus({ advanced, agent }) {
  const { t } = useI18n();
  if (!agent) {
    return (
      <div className="pi-chat-agent-status warning">
        <AlertTriangle size={14} />
        <div>
          <strong>{t('chat.notConnected')}</strong>
          <span>{t('chat.configureConnections')}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`pi-chat-agent-status ${agent.enabled ? '' : 'warning'}`}>
      {agent.enabled ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      <div>
        <strong>{agent.enabled ? t('chat.connected') : t('chat.agentUnavailable')}</strong>
        <span>{advanced ? advancedAgentLabel(agent, t) : agent.enabled ? t('chat.ready') : t('chat.checkConnections')}</span>
      </div>
    </div>
  );
}

function advancedAgentLabel(agent, t) {
  const provider = agent.model_provider || t('chat.context.providerUnset');
  const model = agent.model_id || t('chat.context.modelUnset');
  return `${provider} / ${model} · ${shortId(agent.id)}`;
}

function LoadingState() {
  const { t } = useI18n();
  return (
    <div className="pi-chat-empty">
      <TurtleLoader label={t('chat.loading')} />
    </div>
  );
}

function ChatErrorState({ advanced, error, navigateTo, onAdvancedChange, onRetry }) {
  const { t } = useI18n();
  return (
    <div className="pi-chat-empty pi-chat-error" role="alert">
      <AlertTriangle size={34} />
      <strong>{t('chat.unavailable')}</strong>
      <span>{t('chat.unavailableDescription')}</span>
      {advanced && <code>{error}</code>}
      <div className="pi-chat-empty-actions">
        <button className="btn btn-primary" onClick={onRetry} type="button"><RefreshCw size={14} /> {t('chat.retry')}</button>
        <button
          aria-pressed={advanced}
          className="btn btn-secondary"
          onClick={() => onAdvancedChange(value => !value)}
          type="button"
        >
          <SlidersHorizontal size={14} /> {t('settings.advanced')}
        </button>
        <button className="btn btn-secondary" onClick={() => navigateTo('connections')} type="button">{t('chat.openConnections')}</button>
      </div>
    </div>
  );
}

function EmptyChat({ hasRuntime, navigateTo, onPromptSelect }) {
  const { t } = useI18n();
  return (
    <div className="pi-chat-empty">
      <Bot size={34} />
      <strong>{hasRuntime ? t('chat.start') : t('chat.notConnected')}</strong>
      <span>{hasRuntime ? t('chat.startDescription') : t('chat.configureBeforeStart')}</span>
      {hasRuntime && (
        <div className="pi-chat-starters">
          {['project', 'document', 'code'].map((kind) => (
            <button key={kind} onClick={() => onPromptSelect(t(`chat.starter.${kind}.prompt`))} type="button">
              <span>{t(`chat.starter.${kind}.title`)}</span>
              <small>{t(`chat.starter.${kind}.detail`)}</small>
            </button>
          ))}
        </div>
      )}
      {!hasRuntime && <button className="btn btn-secondary" onClick={() => navigateTo('connections')}>{t('chat.openConnections')}</button>}
    </div>
  );
}

function ChatBubble({ advanced, conversation, item }) {
  const { t } = useI18n();
  const copyDebugInfo = () => copyMessageDebugInfo(null, item, conversation, t('chat.messageDebugCopied'));
  const conversationId = item.meta?.conversation_id || conversation?.id || '';
  const sessionId = item.meta?.pi_session_id || conversation?.pi_session_id || '';
  const displayText = item.role === 'error' && !advanced
    ? t('chat.turnIncomplete')
    : item.text;
  const assistant = item.role === 'assistant';
  const error = item.role === 'error';
  return (
    <article
      className={`pi-chat-bubble ${item.role}`}
      onContextMenu={advanced ? (event) => copyMessageDebugInfo(event, item, conversation, t('chat.messageDebugCopied')) : undefined}
      title={advanced ? t('chat.copyMessageDebugHint') : undefined}
    >
      <header className="pi-chat-bubble-header">
        <span className="pi-chat-bubble-avatar" aria-hidden="true">
          {assistant ? <Bot size={15} /> : error ? <AlertTriangle size={15} /> : <UserRound size={15} />}
        </span>
        <span className="pi-chat-bubble-role">{assistant ? PRODUCT_TERMS.productLatin : error ? t('chat.incomplete') : t('chat.you')}</span>
      </header>
      <div className="pi-chat-bubble-content">
        <PiChatMessageContent advanced={advanced} text={displayText} />
      </div>
      {advanced && (conversationId || sessionId) && (
        <div className="pi-chat-bubble-meta">
          <span>{piBubbleMetaLabel(conversationId, sessionId)}</span>
          <button aria-label={t('chat.copyMessageDebug')} onClick={copyDebugInfo} title={t('chat.copyMessageDebug')} type="button">
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
  const { t } = useI18n();
  const mode = context.fields.permission_mode || '';
  const references = context.references || [];
  return (
    <section className="pi-chat-context-card" aria-label={t('chat.context.runnerPage')}>
      <div className="pi-chat-context-card-icon"><ShieldCheck size={16} /></div>
      <div className="pi-chat-context-card-copy">
        <div className="pi-chat-context-card-title">
          <strong>{t('chat.context.attached')}</strong>
          <span data-mode={mode}>{runnerContextModeLabel(mode, t)}</span>
        </div>
        <p>{mode === 'read_only' ? t('chat.context.readOnlyDescription') : t('chat.context.controlledDescription')}</p>
        {references.length > 0 && (
          <div className="pi-chat-context-card-references">
            {references.map((reference, index) => <span key={`${reference.type}-${index}`}>{runnerContextReferenceLabel(reference, t)}</span>)}
          </div>
        )}
        {advanced && <RunnerUiContextDetails context={context} />}
      </div>
    </section>
  );
}

function RunnerUiContextDetails({ context }) {
  const { t } = useI18n();
  return (
    <details className="pi-chat-context-card-details">
      <summary>{t('chat.context.technical')}</summary>
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

function copyConversationDebugInfo(event, conversation, successMessage) {
  if (!conversation) return;
  event?.preventDefault();
  copyPiDebugText(formatPiConversationDebugInfo(conversation), successMessage);
}

function copyMessageDebugInfo(event, item, conversation, successMessage) {
  event?.preventDefault();
  copyPiDebugText(formatPiMessageDebugInfo(item, conversation), successMessage);
}

function filterConversations(conversations, query, t) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return conversations;
  return conversations.filter((conversation) => [
    displayPiConversationTitle(conversation, t),
    conversation.project_id,
    conversation.id,
  ].some((value) => String(value || '').toLocaleLowerCase().includes(needle)));
}

function formatConversationDate(value, language) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(language || 'zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(language || 'zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

function conversationRuntimePresentation(conversation, unread, t) {
  if (conversation.runtime_status === 'running') return { label: t('chat.status.sending'), tone: 'running' };
  if (unread) return { label: t('chat.status.unread'), tone: 'unread' };
  return null;
}

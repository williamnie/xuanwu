import { AlertTriangle, ArrowUpRight, BriefcaseBusiness, Code2, Copy, FolderGit2, RefreshCw, Sparkles } from 'lucide-react';
import { PRODUCT_TERMS } from '../brand';
import { ChatThread } from './PiChatThread.jsx';
import TurtleLoader from '../components/TurtleLoader';
import { copyPiDebugText, formatPiErrorDebugInfo } from './piChatDiagnostics';
import { displayPiConversationTitle, piChatStatusSummary, piChatWorkLinks } from './piChatPresentation';
import { usePiChatState } from './piChatState';
import { useI18n } from '../i18n/context.js';
import { PiChatSidebar } from './PiChatSidebar.jsx';
import { ChatComposer } from './PiChatComposer.jsx';
import { openSupervisorSettings, copyConversationDebugInfo } from './piChatNavigation.js';
import './PiChat.css';
import './PiChatDiagnostics.css';
import './PiChatSidebar.css';
import './PiChatThread.css';

export default function PiChat({ navigateTo, initialConversationId = '', onConversationChange = null, embedded = false }) {
  const state = usePiChatState(initialConversationId, onConversationChange);
  return embedded ? <PiChatMain embedded navigateTo={navigateTo} state={state} /> : <PiChatLayout navigateTo={navigateTo} state={state} />;
}

function PiChatLayout({ navigateTo, state }) {
  return (
    <div className="pi-chat-page bg-grid-tech animate-fade-in">
      <PiChatSidebar navigateTo={navigateTo} state={state} />
      <section className="pi-chat-shell">
        <PiChatMain navigateTo={navigateTo} state={state} />
      </section>
    </div>
  );
}

function PiChatMain({ embedded = false, navigateTo, state }) {
  return (
    <main className="pi-chat-main glass-card">
      {state.error ? (
        <ChatErrorState
          error={state.error}
          navigateTo={navigateTo}
          onRetry={state.loadPiState}
        />
      ) : state.loading ? <LoadingState /> : (
        <>
          <ChatHeader state={state} />
          {!embedded ? <ChatContextBar navigateTo={navigateTo} project={state.selectedProject} transcript={state.transcript} /> : null}
          <ChatThread embedded={embedded} navigateTo={navigateTo} state={state} />
          <ChatComposer state={state} />
        </>
      )}
    </main>
  );
}

function ChatHeader({ state }) {
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
      onContextMenu={(event) => copyConversationDebugInfo(event, state.selectedConversation, t('chat.debugCopied'))}
      title={t('chat.copyConversationDebugHint')}
    >
      <div className="pi-chat-title-group">
        <span className="font-mono">04 ASK_XUANWU · {PRODUCT_TERMS.productLatin} · Xuanwu assistant</span>
        <strong>{title}</strong>
      </div>
      <div className="pi-chat-header-actions">
        <ChatStatusSummary summary={summary} />
        <button
          className="pi-chat-copy-button"
          disabled={!state.selectedConversation}
          onClick={() => copyConversationDebugInfo(null, state.selectedConversation, t('chat.debugCopied'))}
          title={t('chat.copyConversationDebug')}
          type="button"
        >
          <Copy size={13} /> {t('chat.copyConversationDebug')}
        </button>
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
            <button key={work.id} onClick={() => navigateTo('tasks', work.id)} type="button">
              {work.label} <ArrowUpRight size={13} />
            </button>
          ))}
          <button className="pi-chat-all-work-link" onClick={() => navigateTo('tasks')} type="button">
            {t('chat.viewAll')} <ArrowUpRight size={13} />
          </button>
        </span>
      )}
    </nav>
  );
}

function LoadingState() {
  const { t } = useI18n();
  return (
    <div className="pi-chat-empty">
      <TurtleLoader label={t('chat.loading')} />
    </div>
  );
}

function ChatErrorState({ error, navigateTo, onRetry }) {
  const { t } = useI18n();
  return (
    <div className="pi-chat-empty pi-chat-error" role="alert">
      <AlertTriangle size={34} />
      <strong>{t('chat.unavailable')}</strong>
      <span>{t('chat.unavailableDescription')}</span>
      <div className="pi-chat-empty-actions">
        <button className="btn btn-primary" onClick={onRetry} type="button"><RefreshCw size={14} /> {t('chat.retry')}</button>
        <button
          className="btn btn-secondary"
          onClick={() => copyPiDebugText(formatPiErrorDebugInfo(error), t('chat.debugCopied'))}
          type="button"
        >
          <Copy size={14} /> {t('chat.copyDebug')}
        </button>
        <button className="btn btn-secondary" onClick={() => openSupervisorSettings(navigateTo)} type="button">{t('chat.openSupervisorSettings')}</button>
      </div>
    </div>
  );
}

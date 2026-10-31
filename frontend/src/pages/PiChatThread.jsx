import { AlertTriangle, Bot, ChevronDown, ShieldCheck, UserRound } from 'lucide-react';
import { PRODUCT_TERMS } from '../brand';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import { copyPiDebugText, formatPiMessageDebugInfo } from './piChatDiagnostics';
import { parsePiChatMessageContent, runnerContextModeLabel, runnerContextReferenceLabel } from './piChatMessageContent';
import { useSmartAutoScroll } from './sessions/smartAutoScroll';
import { useI18n } from '../i18n/context.js';
import { openSupervisorSettings } from './piChatNavigation.js';

export function ChatThread({ embedded = false, navigateTo, state }) {
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
          {state.transcript.length === 0 ? (embedded ? <p className="onboarding-delivery-empty">当前会话用于这次交付检查。可以在下方说明需要协助的事项。</p> : <EmptyChat
              navigateTo={navigateTo}
              hasRuntime={Boolean(state.supervisor)}
              onPromptSelect={state.setPrompt}
            />
          ) : state.transcript.map((item) => (
            <ChatBubble key={item.id} conversation={state.selectedConversation} item={item} />
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
      {!hasRuntime && <button className="btn btn-secondary" onClick={() => openSupervisorSettings(navigateTo)}>{t('chat.openSupervisorSettings')}</button>}
    </div>
  );
}

function ChatBubble({ conversation, item }) {
  const { language, t } = useI18n();
  const displayText = item.role === 'error' ? t('chat.turnIncomplete') : item.text;
  const assistant = item.role === 'assistant';
  const error = item.role === 'error';
  return (
    <article
      className={`pi-chat-bubble ${item.role}`}
      onContextMenu={(event) => copyMessageDebugInfo(event, item, conversation, t('chat.messageDebugCopied'))}
      title={t('chat.copyMessageDebugHint')}
    >
      <header className="pi-chat-bubble-header">
        <span className="pi-chat-bubble-avatar" aria-hidden="true">
          {assistant ? <Bot size={15} /> : error ? <AlertTriangle size={15} /> : <UserRound size={15} />}
        </span>
        <span className="pi-chat-bubble-role">{assistant ? PRODUCT_TERMS.productLatin : error ? t('chat.incomplete') : t('chat.you')}</span>
        {item.created_at && <time className="pi-chat-bubble-time" dateTime={item.created_at}>{formatMessageTime(item.created_at, language)}</time>}
      </header>
      <div className="pi-chat-bubble-content">
        <PiChatMessageContent text={displayText} />
      </div>
    </article>
  );
}

function PiChatMessageContent({ text }) {
  return parsePiChatMessageContent(text).map((segment, index) => {
    if (segment.type === 'runner_ui_context') {
      return <RunnerUiContextCard context={segment.context} key={`context-${index}`} />;
    }
    return <MarkdownPreview key={`markdown-${index}`} text={segment.text} className="pi-chat-markdown" />;
  });
}

function RunnerUiContextCard({ context }) {
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
      </div>
    </section>
  );
}

function copyMessageDebugInfo(event, item, conversation, successMessage) {
  event?.preventDefault();
  copyPiDebugText(formatPiMessageDebugInfo(item, conversation), successMessage);
}

function formatMessageTime(value, language) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language || 'zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

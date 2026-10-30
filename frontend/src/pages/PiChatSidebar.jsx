import { AlertTriangle, CheckCircle2, MessageSquarePlus, RefreshCw, Search, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { displayPiConversationTitle, visiblePiConversations } from './piChatPresentation';
import { useI18n } from '../i18n/context.js';
import { openSupervisorSettings, copyConversationDebugInfo } from './piChatNavigation.js';

const PI_CHAT_APP_SIDEBAR_SLOT_ID = 'sessions-app-sidebar-slot';

export function PiChatSidebar({ navigateTo, state }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [portalTarget, setPortalTarget] = useState(null);
  const conversations = filterConversations(visiblePiConversations(state.conversations), query, t);

  useEffect(() => {
    setPortalTarget(document.getElementById(PI_CHAT_APP_SIDEBAR_SLOT_ID));
  }, []);

  if (!portalTarget) return null;

  return createPortal((
    <div className="sessions-app-sidebar-panel pi-chat-app-sidebar-panel">
      <div className="sidebar-shortcut-items">
        <button
          className="sidebar-shortcut-item pi-chat-new-button"
          disabled={state.sending}
          onClick={state.handleCreateConversation}
          type="button"
        >
          <span className="sidebar-shortcut-item-icon"><MessageSquarePlus size={16} /></span>
          <span>{t('chat.new')}</span>
        </button>
      </div>

      <PiChatSidebarHeader
        loading={state.loading}
        navigateTo={navigateTo}
        onRefresh={state.loadPiState}
      />
      <AgentStatus agent={state.supervisor} />
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
      <div className="sidebar-scroll-area pi-chat-sidebar-scroll">
        <ConversationList
          conversations={conversations}
          emptyLabel={query ? t('chat.noSearchResults') : t('chat.emptyList')}
          selectedId={state.selectedConversationId}
          unreadIds={state.unreadConversationIds}
          onSelect={state.handleConversationChange}
        />
      </div>
    </div>
  ), portalTarget);
}

function PiChatSidebarHeader({ loading, navigateTo, onRefresh }) {
  const { t } = useI18n();
  return (
    <div className="pi-chat-sidebar-heading">
      <div>
        <span className="sidebar-section-title">{t('chat.chats')}</span>
      </div>
      <div className="pi-chat-sidebar-heading-actions">
        <button aria-label={t('chat.refresh')} className="pi-chat-sidebar-icon-btn" onClick={onRefresh} disabled={loading} title={t('chat.refresh')} type="button">
          <RefreshCw size={13} className={loading ? 'spin-animation' : ''} />
        </button>
        <button aria-label={t('chat.openSupervisorSettings')} className="pi-chat-sidebar-icon-btn" onClick={() => openSupervisorSettings(navigateTo)} title={t('chat.openSupervisorSettings')} type="button">
          <Settings2 size={13} />
        </button>
      </div>
    </div>
  );
}

function ConversationList({ conversations, emptyLabel, onSelect, selectedId, unreadIds }) {
  const { language, t } = useI18n();
  return (
    <div className="pi-chat-conversation-list">
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
              onContextMenu={(event) => copyConversationDebugInfo(event, conversation, t('chat.debugCopied'))}
              title={t('chat.copyChatDebugHint')}
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
                <span aria-hidden="true">·</span>
                <span>{conversation.project_id ? `@${conversation.project_id}` : t('chat.global')}</span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

function AgentStatus({ agent }) {
  const { t } = useI18n();
  if (!agent) {
    return (
      <div className="pi-chat-agent-status warning">
        <AlertTriangle size={14} />
        <div>
          <strong>{t('chat.notConnected')}</strong>
          <span>{t('chat.configureSupervisor')}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`pi-chat-agent-status ${agent.enabled ? '' : 'warning'}`}>
      {agent.enabled ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      <div>
        <strong>{agent.enabled ? t('chat.connected') : t('chat.agentUnavailable')}</strong>
        <span>{agent.enabled ? t('chat.ready') : t('chat.checkSupervisorSettings')}</span>
      </div>
    </div>
  );
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

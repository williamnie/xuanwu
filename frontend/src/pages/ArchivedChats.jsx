import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveRestore, ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import './ArchivedChats.css';

const PAGE_SIZE = 20;
const SCROLL_PREFETCH_PX = 180;
const EMPTY_PAGE = { items: [], next_cursor: null, total: 0 };

export default function ArchivedChats({ navigateTo }) {
  const controller = useArchivedChatController();
  return (
    <div className="archived-chat-page animate-fade-in">
      <header className="archived-chat-header">
        <button className="archived-chat-back" onClick={() => navigateTo('pi-chat')} type="button">
          <ArrowLeft size={16} />
          Back
        </button>
        <div>
          <span>Personal</span>
          <h1>Archived Chats</h1>
        </div>
        <button className="archived-chat-refresh" disabled={controller.loading} onClick={controller.reload} type="button">
          <RefreshCw className={controller.loading ? 'spin-animation' : ''} size={16} />
          Refresh
        </button>
      </header>
      <ArchivedChatBody {...controller} />
    </div>
  );
}

function useArchivedChatController() {
  const [state, setState] = useArchivedChatFields();
  const loadRef = useRef(false);
  const loadPage = useArchivedPageLoader(setState, loadRef);
  const handleRestore = useArchivedRestore(setState);

  useEffect(() => {
    loadPage();
  }, [loadPage]);

  const loadMore = useCallback(() => {
    if (!state.nextCursor || state.loading || state.loadingMore) return;
    loadPage({ cursor: state.nextCursor, mode: 'append' });
  }, [loadPage, state.loading, state.loadingMore, state.nextCursor]);

  return {
    ...state,
    hasMore: Boolean(state.nextCursor),
    onLoadMore: loadMore,
    onReload: loadPage,
    onRestore: handleRestore,
    reload: loadPage,
  };
}

function useArchivedChatFields() {
  return useState(() => ({
    error: '',
    items: [],
    loading: true,
    loadingMore: false,
    nextCursor: '',
    restoringId: '',
    total: 0,
  }));
}

function useArchivedPageLoader(setState, loadRef) {
  return useCallback(async ({ cursor = '', mode = 'replace' } = {}) => {
    if (loadRef.current) return;
    loadRef.current = true;
    setState((current) => ({ ...current, error: '', loading: mode === 'replace', loadingMore: mode === 'append' }));
    try {
      const page = normalizeArchivedPage(await api.getArchivedPiConversations({ cursor, pageSize: PAGE_SIZE }));
      setState((current) => ({
        ...current,
        error: '',
        items: mode === 'append' ? mergeArchivedChats(current.items, page.items) : page.items,
        loading: false,
        loadingMore: false,
        nextCursor: page.next_cursor || '',
        total: page.total,
      }));
    } catch (err) {
      setState((current) => ({
        ...current,
        error: err.message || '读取 Archived Chats 失败',
        loading: false,
        loadingMore: false,
      }));
    } finally {
      loadRef.current = false;
    }
  }, [loadRef, setState]);
}

function useArchivedRestore(setState) {
  return useCallback(async (sessionId) => {
    setState((current) => ({ ...current, restoringId: sessionId }));
    try {
      await api.restorePiConversation(sessionId);
      setState((current) => ({
        ...current,
        items: current.items.filter((item) => item.id !== sessionId),
        restoringId: '',
        total: Math.max(0, current.total - 1),
      }));
      message.success('Archived Chat 已恢复');
    } catch (err) {
      setState((current) => ({ ...current, restoringId: '' }));
      message.error(err.message || '恢复 Archived Chat 失败');
    }
  }, [setState]);
}

function ArchivedChatBody(props) {
  if (props.loading) return <ArchivedState icon={<Loader2 className="spin-animation" size={22} />} text="Loading archived chats..." />;
  if (props.error) {
    return (
      <ArchivedState text={props.error}>
        <button className="archived-chat-state-action" onClick={props.onReload} type="button">Try again</button>
      </ArchivedState>
    );
  }
  if (props.items.length === 0) return <ArchivedState icon={<ArchiveRestore size={24} />} text="No archived chats yet" />;
  return <ArchivedChatList {...props} />;
}

function ArchivedChatList({ hasMore, items, loadingMore, onLoadMore, onRestore, restoringId, total }) {
  const scrollRef = useArchivedScrollLoader({ hasMore, loadingMore, onLoadMore });
  return (
    <section className="archived-chat-panel">
      <div className="archived-chat-summary">{items.length} / {total} archived chats</div>
      <div className="archived-chat-list" onScroll={scrollRef} role="list">
        {items.map((session) => (
          <ArchivedChatRow
            key={session.id}
            onRestore={onRestore}
            restoring={restoringId === session.id}
            session={session}
          />
        ))}
        {loadingMore && <div className="archived-chat-loading-more"><Loader2 className="spin-animation" size={14} /> Loading more...</div>}
      </div>
    </section>
  );
}

function ArchivedChatRow({ onRestore, restoring, session }) {
  return (
    <article className="archived-chat-row" role="listitem">
      <div className="archived-chat-row-meta">
        <time className="archived-chat-date" dateTime={session.archivedAt}>{formatArchivedDate(session.archivedAt)}</time>
        <strong className="archived-chat-title">{session.title}</strong>
        <span className="archived-chat-project">{session.projectTitle || 'Runner conversation'}</span>
      </div>
      <button
        className="archived-chat-unarchive"
        disabled={restoring}
        onClick={() => onRestore(session.id)}
        type="button"
      >
        {restoring ? <Loader2 className="spin-animation" size={12} /> : <ArchiveRestore size={12} />}
        Unarchive
      </button>
    </article>
  );
}

function ArchivedState({ children, icon = null, text }) {
  return (
    <div className="archived-chat-state">
      {icon}
      <span>{text}</span>
      {children}
    </div>
  );
}

function useArchivedScrollLoader({ hasMore, loadingMore, onLoadMore }) {
  const frameRef = useRef(0);
  return useCallback((event) => {
    if (!hasMore || loadingMore || frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      if (nearScrollBottom(event.currentTarget)) onLoadMore();
    });
  }, [hasMore, loadingMore, onLoadMore]);
}

function nearScrollBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < SCROLL_PREFETCH_PX;
}

function normalizeArchivedPage(page) {
  const safePage = page && typeof page === 'object' ? page : EMPTY_PAGE;
  const items = Array.isArray(safePage.items) ? safePage.items.map(normalizeArchivedSession).filter(Boolean) : [];
  return {
    items,
    next_cursor: typeof safePage.next_cursor === 'string' ? safePage.next_cursor : '',
    total: typeof safePage.total === 'number' ? safePage.total : items.length,
  };
}

function normalizeArchivedSession(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.session_id || item.id || '').trim();
  if (!id) return null;
  return {
    archivedAt: String(item.archived_at || item.updated_at || ''),
    id,
    projectTitle: String(item.project_name || item.project_title || item.project_id || '').trim(),
    title: String(item.title || 'Untitled Chat').trim(),
  };
}

function mergeArchivedChats(current, next) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}

function formatArchivedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || 'Unknown date';
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'short',
    second: '2-digit',
    year: 'numeric',
  }).format(date).replace(',', '');
}

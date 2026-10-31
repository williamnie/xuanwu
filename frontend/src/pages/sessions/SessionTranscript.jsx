import { useMemo } from 'react';
import { shouldRenderLiveTurn } from './sessionTranscriptItems';
import { useSmartAutoScroll } from './smartAutoScroll';
import { SessionTranscriptHeader } from './SessionTranscriptHeader.jsx';
import SessionCommandReplay from './SessionCommandReplay.js';
import { TurnItem, OptimisticUserMessageBubble, LiveTurnItem } from './SessionTranscriptTurns.jsx';
import { ChevronDown } from 'lucide-react';
import './SessionCommandReplay.css';
import './SessionTranscript.css';

export default function SessionTranscript({
  session,
  project,
  liveEvents,
  optimisticUserMessages,
  running,
  sending,
  pendingApproval,
  navigateTo,
  hasOlderTurns = false,
  loadOlderTurns,
  turnsLoading = false,
}) {
  const turns = useMemo(() => session?.turns || [], [session?.turns]);
  const localUserMessages = useMemo(
    () => optimisticUserMessages.filter((message) => message.sessionId === session?.id),
    [optimisticUserMessages, session?.id],
  );
  const working = Boolean(running || sending);
  const showLiveTurn = shouldRenderLiveTurn(liveEvents, working);
  const providerId = String(session?.provider || 'codex').toLowerCase();
  const providerSessionId = session?.provider_session_id || session?.sessionId || session?.id || '';
  const model = session?.model || '';
  const transcriptClock = useMemo(() => ({
    createdAt: session?.createdAt,
    created_at: session?.created_at,
    updatedAt: session?.updatedAt,
    updated_at: session?.updated_at,
  }), [session?.createdAt, session?.created_at, session?.updatedAt, session?.updated_at]);
  const lastLiveEvent = liveEvents[liveEvents.length - 1];
  const autoScrollWatchKey = [
    session?.updatedAt || '',
    turns.length,
    localUserMessages.map((message) => `${message.id}:${message.prompt}`).join('|'),
    liveEvents.length,
    lastLiveEvent?.method || lastLiveEvent?.agent_event_type || '',
    lastLiveEvent?.payload || lastLiveEvent?.text || lastLiveEvent?.error || '',
    working ? 'running' : 'idle',
    pendingApproval ? 'approval' : '',
  ].join(':');
  const {
    scrollRef,
    contentRef,
    showScrollButton,
    handleScroll,
    scrollToLatest,
  } = useSmartAutoScroll({
    resetKey: session?.id || providerSessionId,
    watchKey: autoScrollWatchKey,
  });

  return (
    <div className="session-detail-body">
      <SessionTranscriptHeader session={session} project={project} running={running} working={working} pendingApproval={pendingApproval} navigateTo={navigateTo} />
      <SessionCommandReplay history={session?.command_history || []} navigateTo={navigateTo} />
      <div className="session-transcript" ref={scrollRef} onScroll={handleScroll}>
        <div className="session-transcript-content" ref={contentRef}>
          {hasOlderTurns ? (
            <button
              className="session-load-earlier-button"
              disabled={turnsLoading}
              onClick={loadOlderTurns}
              type="button"
            >
              {turnsLoading ? '正在加载…' : '加载更早记录'}
            </button>
          ) : null}
          {turns.map((turn, index) => (
            <TurnItem
              key={turn.id || index}
              turn={turn}
              turnIndex={index}
              provider={providerId}
              model={model}
              project={project}
              session={transcriptClock}
            />
          ))}
          {localUserMessages.map((message) => (
            <OptimisticUserMessageBubble key={message.id} message={message} />
          ))}
          {showLiveTurn && (
            <LiveTurnItem
              key={session?.id || providerSessionId}
              liveEvents={liveEvents}
              persistedTurns={turns}
              provider={providerId}
            />
          )}
        </div>
      </div>
      {showScrollButton && (
        <button type="button" className="session-scroll-bottom-button" onClick={scrollToLatest}>
          <ChevronDown size={14} />
          回到底部
        </button>
      )}
    </div>
  );
}

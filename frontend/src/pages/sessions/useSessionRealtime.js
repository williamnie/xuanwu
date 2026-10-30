import { useRef, useCallback, useEffect } from 'react';
import { providerSessionKey, eventSessionKey, isSessionFileEvent, isAgentEvent, parseApprovalPayload, eventSessionKeyFromPayload, parseApprovalResolvedPayload, isSessionStartEvent, upsertRunningSessionFromEvent, setSessionRunningInList } from './sessionPageRuntime';
import { eventsApi } from '../../api/events.js';
import { enqueueApprovalNotice, removeApprovalRequest, removeApprovalsForSession } from './approvalQueue';
import { message as toast } from '../../store/toastStore';
import { isSessionStopEvent, isInterruptPendingForSession, interruptCompletionNotice } from './sessionInterrupt';
import { showToastNotice } from './sessionNotices.js';

const SESSION_LIST_REFRESH_DELAY_MS = 800;
const SESSION_DETAIL_REFRESH_DELAY_MS = 250;
export default function useSessionRealtime({
  showSidebar,
  loadFirstPage,
  selectedId,
  loadSelected,
  selectedIdRef,
  setApprovalQueue,
  setSessions,
  projects,
  interruptStateRef,
  applyInterruptNotice,
  setLiveEvents,
  setSessionRunning,
}) {
  const listRefreshTimer = useRef(null);
  const detailRefreshTimer = useRef(null);
  const scheduleListRefresh = useCallback(() => {
    if (!showSidebar) return;
    window.clearTimeout(listRefreshTimer.current);
    listRefreshTimer.current = window.setTimeout(() => loadFirstPage({
      silent: true,
      preserveLoaded: true,
      reportErrors: false,
    }), SESSION_LIST_REFRESH_DELAY_MS);
  }, [loadFirstPage, showSidebar]);

  const scheduleSelectedRefresh = useCallback((provider, threadId) => {
    const eventKey = providerSessionKey(provider, threadId);
    if (!threadId || eventKey !== selectedId) return;
    window.clearTimeout(detailRefreshTimer.current);
    detailRefreshTimer.current = window.setTimeout(
      () => loadSelected(false, { refreshTranscript: true }),
      SESSION_DETAIL_REFRESH_DELAY_MS,
    );
  }, [loadSelected, selectedId]);

  const refreshSelectedApprovals = useCallback(() => {
    if (selectedIdRef.current) loadSelected(false);
  }, [loadSelected, selectedIdRef]);

  useEffect(() => eventsApi.subscribeToEvents((event) => {
    const eventKey = eventSessionKey(event);
    if (isSessionFileEvent(event)) {
      scheduleListRefresh();
      scheduleSelectedRefresh(event.provider, event.threadId);
      return;
    }
    if (!isAgentEvent(event)) return;
    if (event.method === 'approval/requested') {
      const request = parseApprovalPayload(event.payload);
      const requestSessionKey = eventKey || eventSessionKeyFromPayload(request) || selectedIdRef.current;
      setApprovalQueue((current) => enqueueApprovalNotice(current, { request, sessionId: requestSessionKey }));
      if (requestSessionKey && requestSessionKey !== selectedIdRef.current) {
        toast.info('编程工具正在等待审批，切回对应 session 后可处理。');
      }
    }
    if (event.method === 'approval/resolved') {
      setApprovalQueue((current) => removeApprovalRequest(current, parseApprovalResolvedPayload(event.payload)));
    }
    if (event.threadId && isSessionStartEvent(event)) {
      setSessions((prev) => upsertRunningSessionFromEvent(prev, event, projects));
      scheduleListRefresh();
    }
    if (event.threadId && isSessionStopEvent(event)) {
      setSessions((prev) => setSessionRunningInList(prev, eventKey, false));
      setApprovalQueue((current) => removeApprovalsForSession(current, eventKey));
      if (isInterruptPendingForSession(interruptStateRef.current, eventKey)) {
        const notice = interruptCompletionNotice(eventKey, event);
        applyInterruptNotice(notice);
        showToastNotice(notice);
      }
    }
    if (eventKey !== selectedId) return;
    if (isSessionStartEvent(event)) {
      setLiveEvents([event]);
      setSessionRunning(true);
      return;
    }
    setLiveEvents((prev) => [...prev, event].slice(-200));
    if (isSessionStopEvent(event)) {
      const stoppedSessionId = eventKey;
      setSessionRunning(false);
      loadSelected(false, { refreshTranscript: true }).then(() => {
        if (selectedIdRef.current === stoppedSessionId) setLiveEvents([]);
      });
      if (showSidebar) loadFirstPage();
    }
  }, undefined, refreshSelectedApprovals), [loadFirstPage, loadSelected, refreshSelectedApprovals, scheduleListRefresh, scheduleSelectedRefresh, selectedId, applyInterruptNotice, projects, showSidebar, setLiveEvents, selectedIdRef, setApprovalQueue, setSessions, interruptStateRef, setSessionRunning]);

  useEffect(() => () => {
    window.clearTimeout(detailRefreshTimer.current);
    window.clearTimeout(listRefreshTimer.current);
  }, []);

}

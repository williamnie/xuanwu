import { useProjectNodes } from '../../store/useProjectNodes.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evidenceApi } from '../../api/evidence.js';
import { handoffsApi } from '../../api/handoffs.js';
import { workApi } from '../../api/work.js';
import { message } from '../../store/toastStore.js';
import { useHumanReview } from '../work/useHumanReview.jsx';
import { issueIdFromWorkId } from '../workBoardModel.js';
import { buildWorkActionPayload, defaultWorkDetailTab, filterTimelineItems, mergeTimelinePages, workAvailableActions, workBlockReason } from '../workDetailModel.js';
import { useI18n } from '../../i18n/context.js';

const EMPTY_RESULTS = { evidence: [], handoffs: [] };
const DEFAULT_ACCEPTANCE_ID = 'issue-delivery';


export default function useWorkDetail({ onPageContextChange, onWorkChanged, projects, selectedHandoffId, selectedRunId, workId }) {
  const nodesById = useProjectNodes();
  const { language, t } = useI18n();
  const detailRequest = useRef(0);
  const resultsRequest = useRef(0);
  const activityRequest = useRef(0);
  const [detail, setDetail] = useState(null);
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [resultErrors, setResultErrors] = useState({});
  const [latestRun, setLatestRun] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [timelineCursor, setTimelineCursor] = useState('');
  const [timelineKind, setTimelineKind] = useState('');
  const [timelineError, setTimelineError] = useState('');
  const [activeTab, setActiveTab] = useState('');
  const [runCount, setRunCount] = useState(null);
  const [activeDeliveryId, setActiveDeliveryId] = useState(selectedHandoffId);
  const [loading, setLoading] = useState(true);
  const [resultsLoading, setResultsLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [processToken, setProcessToken] = useState(0);
  const [error, setError] = useState('');

  const loadDetail = useCallback(async ({ silent = false } = {}) => {
    const version = ++detailRequest.current;
    if (!silent) setLoading(true);
    setError('');
    try {
      const nextDetail = await workApi.getWork(workId);
      if (version === detailRequest.current) setDetail(nextDetail);
    } catch (loadError) {
      if (version === detailRequest.current) setError(loadError.message || t('work.loadFailed'));
    } finally {
      if (version === detailRequest.current) setLoading(false);
    }
  }, [t, workId]);

  const loadResults = useCallback(async () => {
    const version = ++resultsRequest.current;
    setResultsLoading(true);
    const settled = await Promise.allSettled([
      evidenceApi.listEvidence({ limit: 20, workId }),
      handoffsApi.getHandoffs({ limit: 10, workId }),
    ]);
    if (version !== resultsRequest.current) return;
    const [evidenceResult, handoffsResult] = settled;
    setResults({
      evidence: fulfilledItems(evidenceResult),
      handoffs: fulfilledItems(handoffsResult),
    });
    setResultErrors(settledErrors(settled, ['evidence', 'handoffs']));
    setResultsLoading(false);
  }, [workId]);

  const loadActivity = useCallback(async () => {
    const version = ++activityRequest.current;
    setActivityLoading(true);
    try {
      const response = await workApi.getWorkTimeline(workId, { limit: 60 });
      if (version !== activityRequest.current) return;
      setTimeline(response?.items || []);
      setTimelineCursor(response?.next_cursor || '');
      setTimelineError('');
      setActivityLoaded(true);
    } catch (loadError) {
      if (version === activityRequest.current) setTimelineError(loadError.message || t('work.loadActivityFailed'));
    } finally {
      if (version === activityRequest.current) setActivityLoading(false);
    }
  }, [t, workId]);

  useEffect(() => {
    setDetail(null);
    setResults(EMPTY_RESULTS);
    setResultErrors({});
    setLatestRun(null);
    setTimeline([]);
    setTimelineCursor('');
    setTimelineKind('');
    setTimelineError('');
    setActiveTab('');
    setRunCount(null);
    setActivityLoaded(false);
    setActiveDeliveryId(selectedHandoffId);
    setEditorOpen(false);
    setPendingAction('');
    loadDetail();
    loadResults();
  }, [loadDetail, loadResults, selectedHandoffId]);

  useEffect(() => {
    if (activeTab === 'activity' && !activityLoaded && !activityLoading) loadActivity();
  }, [activeTab, activityLoaded, activityLoading, loadActivity]);

  const work = detail?.work || null;
  const issueId = issueIdFromWorkId(work?.id);
  const project = projects.find(item => item.id === work?.owner?.project_id) || null;
  const projectName = project?.name || work?.owner?.project_id || 'Unscoped';
  const decision = detail?.decision || null;
  const availableActions = workAvailableActions(work?.status, decision);
  const blockReason = workBlockReason(work, project);
  const feedbackPending = ['received', 'executing'].includes(detail?.feedback?.status);
  const workRunning = work?.status === 'in_progress';
  useEffect(() => {
    if (!feedbackPending && !workRunning) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadDetail({ silent: true });
      void loadResults();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [feedbackPending, loadDetail, loadResults, workRunning]);
  const visibleTimeline = useMemo(() => filterTimelineItems(timeline, timelineKind), [timeline, timelineKind]);
  const customAcceptance = useMemo(
    () => (work?.acceptance?.criteria || []).filter(criterion => criterion.id !== DEFAULT_ACCEPTANCE_ID),
    [work],
  );

  useEffect(() => {
    setActiveDeliveryId(current => selectedHandoffId
      || (results.handoffs.some(item => item.id === current) ? current : results.handoffs[0]?.id || ''));
  }, [results.handoffs, selectedHandoffId]);

  // 首次拿到任务时选默认 Tab；之后状态刷新不抢走用户手动选的 Tab。
  const workStatus = work?.status || '';
  useEffect(() => {
    if (workStatus) setActiveTab(current => current || defaultWorkDetailTab(workStatus, { selectedHandoffId, selectedRunId }));
  }, [selectedHandoffId, selectedRunId, workStatus]);

  // 从执行记录页“所属任务”回来时，同一任务也切到执行并高亮那一次。
  useEffect(() => {
    if (selectedRunId) setActiveTab('runs');
  }, [selectedRunId]);

  useEffect(() => {
    if (!work) return;
    onPageContextChange?.({
      page_id: 'tasks',
      project_id: work.owner?.project_id || '',
      work_id: work.id,
      ...(activeDeliveryId ? { handoff_id: activeDeliveryId } : {}),
    });
  }, [activeDeliveryId, onPageContextChange, work]);

  const refreshAll = async () => {
    setRefreshing(true);
    setProcessToken(value => value + 1);
    await Promise.all([loadDetail({ silent: true }), loadResults(), ...(activityLoaded ? [loadActivity()] : [])]);
    setRefreshing(false);
  };

  const loadMoreTimeline = async () => {
    if (!timelineCursor || timelineLoadingMore) return;
    setTimelineLoadingMore(true);
    try {
      const response = await workApi.getWorkTimeline(workId, { cursor: timelineCursor, limit: 60 });
      setTimeline(current => mergeTimelinePages(current, response?.items || []));
      setTimelineCursor(response?.next_cursor || '');
      setTimelineError('');
    } catch (timelineLoadError) {
      setTimelineError(timelineLoadError.message || t('work.loadMoreActivityFailed'));
    } finally {
      setTimelineLoadingMore(false);
    }
  };

  const submitAction = async (action) => {
    if (!work || submitting) return;
    setSubmitting(true);
    try {
      await workApi.controlWork(work.id, action, buildWorkActionPayload(work, action));
      message.success(t(action === 'enqueue' ? 'work.enqueued' : action === 'retry' ? 'work.requeued' : 'work.cancelled'));
      setPendingAction('');
      await refreshAll();
      onWorkChanged?.();
    } catch (actionError) {
      message.error(actionError.message || t('work.actionFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const copyWorkId = async () => {
    try {
      await navigator.clipboard.writeText(work.id);
      message.success(t('work.idCopied'));
    } catch (copyError) {
      message.error(copyError.message || t('work.copyFailed'));
    }
  };

  const handleLatestRunChange = useCallback(run => setLatestRun(run), []);
  const handleRunTotalChange = useCallback(total => setRunCount(total), []);
  const review = useHumanReview({ onSubmitted: async () => { await refreshAll(); onWorkChanged?.(); } });
  return {
    nodesById, language, t, detail, work,
    results, resultErrors, latestRun, timelineCursor, timelineKind,
    timelineError, activeTab, runCount, activeDeliveryId, loading,
    resultsLoading, activityLoading, activityLoaded, timelineLoadingMore, refreshing,
    editorOpen, pendingAction, submitting, processToken, error,
    issueId, project, projectName, decision, availableActions,
    blockReason, visibleTimeline, customAcceptance, setActiveTab, setTimelineKind,
    setActiveDeliveryId, setEditorOpen, setPendingAction, refreshAll, loadMoreTimeline,
    submitAction, copyWorkId, handleLatestRunChange, handleRunTotalChange, review,
  };
}

function fulfilledItems(result) {
  if (result.status !== 'fulfilled') return [];
  if (Array.isArray(result.value)) return result.value;
  return result.value?.items || [];
}

function settledErrors(results, keys) {
  return Object.fromEntries(results.flatMap((result, index) => result.status === 'rejected' ? [[keys[index], result.reason?.message || `Failed to load ${keys[index]}`]] : []));
}

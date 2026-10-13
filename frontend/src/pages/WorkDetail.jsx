import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workHumanReviewCopy } from './workHumanReviewCopy';
import WorkFeedback from './work/WorkFeedback.jsx';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  Copy,
  LoaderCircle,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Square,
} from 'lucide-react';
import { evidenceApi } from '../api/evidence.js';
import { handoffsApi } from '../api/handoffs.js';
import { workApi } from '../api/work.js';
import MarkdownPreview from '../components/editor/MarkdownPreview.jsx';
import { message } from '../store/toastStore.js';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import WorkRunProcess from './work/WorkRunProcess.jsx';
import { HumanReviewCard } from './work/HumanReview.jsx';
import { useHumanReview } from './work/useHumanReview.jsx';
import { workProfileSummary } from './work/workProfileRouting.js';
import WorkDeliveryView from './work/WorkDeliveryView.jsx';
import { issueIdFromWorkId } from './workBoardModel.js';
import {
  WORK_TIMELINE_KINDS,
  buildWorkActionPayload,
  filterTimelineItems,
  mergeTimelinePages,
  workAvailableActions,
  workBlockReason,
} from './workDetailModel.js';
import './WorkDetail.css';
import { useI18n } from '../i18n/context.js';

const EMPTY_RESULTS = { evidence: [], handoffs: [] };
const DEFAULT_ACCEPTANCE_ID = 'issue-delivery';
const NOT_STARTED_STATUSES = new Set(['triage', 'todo']);

// 任务详情单页三段式：现在怎样 → 结果 → 过程（每次执行的完整记录）。
export default function WorkDetail({ navigateTo, onPageContextChange, onWorkChanged, projects = [], selectedHandoffId = '', selectedRunId = '', workId }) {
  const { language, t } = useI18n();
  const detailRequest = useRef(0);
  const resultsRequest = useRef(0);
  const activityRequest = useRef(0);
  const resultsRef = useRef(null);
  const [detail, setDetail] = useState(null);
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [resultErrors, setResultErrors] = useState({});
  const [latestRun, setLatestRun] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [timelineCursor, setTimelineCursor] = useState('');
  const [timelineKind, setTimelineKind] = useState('');
  const [timelineError, setTimelineError] = useState('');
  const [activityOpen, setActivityOpen] = useState(false);
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
    setActivityOpen(false);
    setActivityLoaded(false);
    setActiveDeliveryId(selectedHandoffId);
    setEditorOpen(false);
    setPendingAction('');
    loadDetail();
    loadResults();
  }, [loadDetail, loadResults, selectedHandoffId]);

  useEffect(() => {
    if (activityOpen && !activityLoaded && !activityLoading) loadActivity();
  }, [activityOpen, activityLoaded, activityLoading, loadActivity]);

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

  // 交付深链直接定位到“结果”段。
  useEffect(() => {
    if (selectedHandoffId && !resultsLoading && work) resultsRef.current?.scrollIntoView?.({ block: 'start' });
  }, [resultsLoading, selectedHandoffId, work]);

  useEffect(() => {
    if (!work) return;
    onPageContextChange?.({
      page_id: 'work',
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
  const review = useHumanReview({ onSubmitted: async () => { await refreshAll(); onWorkChanged?.(); } });

  if (loading && !work) return <WorkDetailLoading />;
  if (error || !work) return <WorkDetailFailure error={error} navigateTo={navigateTo} />;

  const profileSummary = workProfileSummary(work, latestRun);
  const hasResults = results.handoffs.length > 0 || results.evidence.length > 0 || resultErrors.evidence || resultErrors.handoffs;

  return (
    <section className="work-detail-page animate-fade-in">
      <div className="work-detail-toolbar">
        <button className="work-detail-back" onClick={() => navigateTo('work')} type="button"><ArrowLeft size={15} /> {t('work.backToBoard')}</button>
        <div className="work-detail-actions">
          {availableActions.start ? <button className="primary" disabled={submitting} onClick={() => submitAction('enqueue')} type="button"><Play size={14} /> {t('work.start')}</button> : null}
          {availableActions.retry ? <button className="primary" disabled={submitting} onClick={() => submitAction('retry')} type="button"><RotateCw size={14} /> {t('work.retry')}</button> : null}
          {availableActions.edit ? <button onClick={() => setEditorOpen(true)} type="button"><Pencil size={14} /> {t('work.edit')}</button> : null}
          {availableActions.cancel ? <button className="danger" disabled={submitting} onClick={() => setPendingAction('cancel')} type="button"><Square size={13} /> {t('work.cancel')}</button> : null}
          <button aria-label={t('work.copyId')} className="icon" onClick={copyWorkId} title={t('work.copyId')} type="button"><Copy size={14} /></button>
          <button aria-label={t('work.refresh')} className="icon" disabled={refreshing} onClick={refreshAll} title={t('work.refresh')} type="button"><RefreshCw className={refreshing ? 'is-spinning' : ''} size={14} /></button>
        </div>
      </div>

      <header className="work-detail-hero">
        <div className="work-detail-eyebrow"><CircleDot size={13} /> TASK{issueId ? ` #${issueId}` : ''}</div>
        <div className="work-detail-title-row">
          <span className="work-detail-status" data-status={work.status}>{t(`status.${work.status}`)}</span>
          <h1>{work.title}</h1>
        </div>
        <div className="work-detail-meta"><span>{projectName}</span><span>{t('work.updated', { time: formatTime(work.updated_at, language) })}</span></div>
      </header>

      {pendingAction ? <InlineConfirmation busy={submitting} onCancel={() => setPendingAction('')} onConfirm={() => submitAction(pendingAction)} /> : null}

      <section className="work-detail-panel">
        <SectionHeading eyebrow="NOW" title={t('work.sectionNow')} />
        {blockReason ? <div className="work-block-reason" role="status"><AlertTriangle size={14} /> {blockReason}</div> : null}
        <WorkStateSummary status={work.status} decision={decision} />
        <WorkFeedback feedback={detail?.feedback} />
        {availableActions.review ? <HumanReviewCard disabled={submitting || review.submitting} onSelect={action => review.select(work, decision.request, action)} request={decision.request} /> : null}
        <details className="work-detail-disclosure" open={NOT_STARTED_STATUSES.has(work.status) || undefined}>
          <summary>{t('work.taskDescription')}</summary>
          <MarkdownPreview text={work.goal || t('work.noGoal')} />
        </details>
        {customAcceptance.length ? (
          <details className="work-detail-disclosure">
            <summary>{t('work.acceptanceCriteria')} ({customAcceptance.length})</summary>
            <ul>{customAcceptance.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul>
          </details>
        ) : null}
      </section>

      {hasResults ? (
        <section className="work-detail-panel work-delivery-panel" ref={resultsRef}>
          <div className="work-delivery-panel-heading"><SectionHeading eyebrow="RESULT" title={t('work.sectionResult')} /></div>
          <WorkDeliveryView
            evidence={results.evidence}
            handoffs={results.handoffs}
            loading={resultsLoading}
            loadError={resultErrors.evidence || resultErrors.handoffs}
            onRefresh={refreshAll}
            onSelectionChange={setActiveDeliveryId}
            selectedHandoffId={activeDeliveryId}
            work={work}
          />
        </section>
      ) : null}

      <section className="work-detail-panel work-process-panel">
        <SectionHeading eyebrow="PROCESS" title={t('work.sectionProcess')} />
        <WorkRunProcess
          allowRunRetry={!availableActions.retry}
          navigateTo={navigateTo}
          onLatestRunChange={handleLatestRunChange}
          onRunsChanged={() => { void loadDetail({ silent: true }); onWorkChanged?.(); }}
          refreshToken={processToken}
          selectedRunId={selectedRunId}
          workId={workId}
        />
        <details className="work-detail-disclosure">
          <summary>{t('work.executionConfig')}</summary>
          <dl className="work-provider-profile-facts">
            <div><dt>{t('work.profile.preset')}</dt><dd>{profileSummary.effectiveProfile}</dd></div>
            <div><dt>{t('work.profile.provider')}</dt><dd>{profileSummary.effectiveProvider}</dd></div>
            <div><dt>{t('work.profile.model')}</dt><dd>{profileSummary.effectiveModel}</dd></div>
            <div><dt>{t('work.profile.source')}</dt><dd>{profileSummary.sourceLabel}</dd></div>
            <div><dt>{t('work.profile.actual')}</dt><dd>{profileSummary.runProvider}</dd></div>
          </dl>
        </details>
        <details className="work-detail-disclosure" onToggle={event => setActivityOpen(event.currentTarget.open)}>
          <summary>{t('work.activity')}</summary>
          <div className="work-timeline-filters" role="group" aria-label={t('work.activityKind')}>
            <button aria-pressed={!timelineKind} onClick={() => setTimelineKind('')} type="button">{t('work.all')}</button>
            {WORK_TIMELINE_KINDS.map(kind => <button aria-pressed={timelineKind === kind} key={kind} onClick={() => setTimelineKind(kind)} type="button">{t(`timeline.${kind}`)}</button>)}
          </div>
          <ResourceError error={timelineError} />
          {activityLoading && !activityLoaded ? <div className="work-activity-loading"><LoaderCircle className="is-spinning" size={18} /> {t('work.loadingActivity')}</div> : null}
          {activityLoaded && !activityLoading && visibleTimeline.length === 0 ? <EmptySection text={timelineKind ? t('work.noMatchingActivity') : t('work.noActivity')} /> : null}
          <div className="work-timeline-list">
            {visibleTimeline.map(item => (
              <article key={item.id}>
                <span className="work-timeline-marker" data-kind={item.kind} />
                <div><div><strong>{item.title}</strong><em>{item.status}</em></div><p>{item.summary}</p><span>{t(`timeline.${item.kind}`)} · {formatTime(item.occurred_at, language)}</span></div>
              </article>
            ))}
          </div>
          {timelineCursor ? <button className="work-timeline-more" disabled={timelineLoadingMore} onClick={loadMoreTimeline} type="button">{timelineLoadingMore ? <LoaderCircle className="is-spinning" size={14} /> : null}{timelineLoadingMore ? t('work.loadingEarlier') : t('work.loadEarlier')}</button> : null}
        </details>
      </section>

      {editorOpen ? <WorkEditorDialog mode="edit" onClose={() => setEditorOpen(false)} onSaved={async () => { setEditorOpen(false); await refreshAll(); onWorkChanged?.(); }} projects={projects} work={work} /> : null}
      {review.dialog}
    </section>
  );
}

function WorkStateSummary({ status, decision }) {
  const { t } = useI18n();
  const pendingSummary = decision?.owner === 'human'
    ? [workHumanReviewCopy(decision?.request?.kind, t).pending, decision?.request?.question || t('work.state.reviewDetail')]
    : decision?.phase === 'pi_continuing'
      ? [t('work.state.piRepairingTitle'), t('work.state.piRepairingDetail')]
      : decision?.phase === 'pi_deciding'
        ? [t('work.state.piVerifyingTitle'), t('work.state.piVerifyingDetail')]
        : decision?.phase === 'pi_error'
          ? [t('work.state.piBlockedTitle'), decision?.activity?.error || t('work.state.piBlockedDetail')]
          : decision?.phase === 'pi_waiting'
            ? [t('work.state.piWaitingTitle'), t('work.state.piWaitingDetail')]
            : [t('work.state.piQueuedTitle'), t('work.state.piQueuedDetail')];
  const summary = {
    cancelled: [t('work.state.cancelledTitle'), t('work.state.cancelledDetail')],
    done: [t('work.state.doneTitle'), t('work.state.doneDetail')],
    failed: [t('work.state.failedTitle'), t('work.state.failedDetail')],
    in_progress: decision?.phase?.startsWith('pi_') ? pendingSummary : [t('work.state.runningTitle'), t('work.state.runningDetail')],
    needs_user: pendingSummary,
    todo: [t('work.state.queuedTitle'), t('work.state.queuedDetail')],
    triage: [t('work.state.readyTitle'), t('work.state.readyDetail')],
  }[status] || [status, t('work.state.unknownDetail')];
  const Icon = status === 'failed' ? AlertTriangle : status === 'done' ? CheckCircle2 : CircleDot;
  return <div className="work-state-summary" data-status={status}><Icon size={18} /><div><strong>{summary[0]}</strong><span>{summary[1]}</span></div></div>;
}

function WorkDetailLoading() {
  const { t } = useI18n();
  return <div className="work-detail-loading"><LoaderCircle className="is-spinning" size={26} /><strong>{t('work.loadingDetail')}</strong></div>;
}

function WorkDetailFailure({ error, navigateTo }) {
  const { t } = useI18n();
  return <section className="work-detail-failure" role="alert"><AlertTriangle size={22} /><div><strong>{t('work.detailUnavailable')}</strong><span>{error || t('work.notFound')}</span></div><button onClick={() => navigateTo('work')} type="button"><ArrowLeft size={14} /> {t('work.backToBoard')}</button></section>;
}

function SectionHeading({ eyebrow, title }) {
  return <header className="work-section-heading"><span>{eyebrow}</span><h2>{title}</h2></header>;
}

function EmptySection({ text }) {
  return <div className="work-section-empty"><CircleDot size={16} /><span>{text}</span></div>;
}

function ResourceError({ error }) {
  return error ? <div className="work-resource-error" role="alert"><AlertTriangle size={14} /> {error}</div> : null;
}

function InlineConfirmation({ busy, onCancel, onConfirm }) {
  const { t } = useI18n();
  return <div className="work-inline-confirm" role="alertdialog" aria-label={t('work.confirmCancel')}><AlertTriangle size={18} /><div><strong>{t('work.confirmCancel')}</strong><span>{t('work.cancelAudit')}</span></div><button disabled={busy} onClick={onCancel} type="button">{t('work.keep')}</button><button className="danger" disabled={busy} onClick={onConfirm} type="button">{busy ? t('work.submitting') : t('work.confirmCancelAction')}</button></div>;
}

function fulfilledItems(result) {
  if (result.status !== 'fulfilled') return [];
  if (Array.isArray(result.value)) return result.value;
  return result.value?.items || [];
}

function settledErrors(results, keys) {
  return Object.fromEntries(results.flatMap((result, index) => result.status === 'rejected' ? [[keys[index], result.reason?.message || `Failed to load ${keys[index]}`]] : []));
}

function formatTime(value, language) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(language) : value;
}

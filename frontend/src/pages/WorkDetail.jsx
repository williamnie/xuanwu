import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workHumanReviewCopy } from './workHumanReviewCopy';
import InboxRequests from './command-center/InboxRequests.jsx';
import WorkFeedback from './work/WorkFeedback.jsx';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  LoaderCircle,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  XCircle,
} from 'lucide-react';
import { evidenceApi } from '../api/evidence.js';
import { handoffsApi } from '../api/handoffs.js';
import { eventsApi } from '../api/events.js';
import { runsApi } from '../api/runs.js';
import { workApi } from '../api/work.js';
import MarkdownPreview from '../components/editor/MarkdownPreview.jsx';
import ModalOverlay from '../components/ModalOverlay.jsx';
import { message } from '../store/toastStore.js';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import { workProfileSummary } from './work/workProfileRouting.js';
import WorkDeliveryView from './work/WorkDeliveryView.jsx';
import TaskRunProcess from './work/TaskRunProcess.jsx';
import { workBlockReason } from './work/workActions.js';
import {
  WORK_TIMELINE_KINDS,
  buildWorkActionPayload,
  filterTimelineItems,
  mergeTimelinePages,
  workAvailableActions,
} from './workDetailModel.js';
import './WorkDetail.css';
import { useI18n } from '../i18n/context.js';

const EMPTY_OVERVIEW = { evidence: [], handoffs: [], runs: [] };
const DEFAULT_ACCEPTANCE_ID = 'issue-delivery';

export default function WorkDetail({ navigateTo, onPageContextChange, onWorkChanged, projects = [], selectedHandoffId = '', initialRunId = '', workId }) {
  const { language, t } = useI18n();
  const detailRequest = useRef(0);
  const overviewRequest = useRef(0);
  const activityRequest = useRef(0);
  const [detail, setDetail] = useState(null);
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [overviewErrors, setOverviewErrors] = useState({});
  const [timeline, setTimeline] = useState([]);
  const [timelineCursor, setTimelineCursor] = useState('');
  const [timelineKind, setTimelineKind] = useState('');
  const [processVisited, setProcessVisited] = useState(Boolean(initialRunId));
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsPage, setRunsPage] = useState(1);
  const [runsMore, setRunsMore] = useState(false);
  const [resultCursors, setResultCursors] = useState({ evidence: '', handoffs: '' });
  const [activeDeliveryId, setActiveDeliveryId] = useState(selectedHandoffId);
  const [loading, setLoading] = useState(true);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [reviewAction, setReviewAction] = useState('');
  const [reviewRequest, setReviewRequest] = useState(null);
  const [reviewComment, setReviewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
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

  const loadOverview = useCallback(async () => {
    const version = ++overviewRequest.current;
    setOverviewLoading(true);
    const results = await Promise.allSettled([
      runsApi.getRuns({ page: 1, pageSize: 10, workId }),
      evidenceApi.listEvidence({ limit: 20, workId }),
      handoffsApi.getHandoffs({ limit: 10, workId }),
    ]);
    if (version !== overviewRequest.current) return;
    const [runsResult, evidenceResult, handoffsResult] = results;
    setOverview({
      runs: fulfilledItems(runsResult),
      evidence: fulfilledItems(evidenceResult),
      handoffs: fulfilledItems(handoffsResult),
    });
    setRunsTotal(runsResult.status === 'fulfilled' ? Number(runsResult.value.total || fulfilledItems(runsResult).length) : 0);
    setRunsMore(runsResult.status === 'fulfilled' && Number(runsResult.value.total || 0) > fulfilledItems(runsResult).length);
    setRunsPage(1);
    setResultCursors({ evidence: evidenceResult.status === 'fulfilled' ? evidenceResult.value.next_cursor || '' : '', handoffs: handoffsResult.status === 'fulfilled' ? handoffsResult.value.next_cursor || '' : '' });
    setOverviewErrors(settledErrors(results, ['runs', 'evidence', 'handoffs']));
    setOverviewLoading(false);
  }, [workId]);

  const loadActivity = useCallback(async () => {
    const version = ++activityRequest.current;
    setActivityLoading(true);
    try {
      const response = await workApi.getWorkTimeline(workId, { limit: 60 });
      if (version !== activityRequest.current) return;
      setTimeline(response?.items || []);
      setTimelineCursor(response?.next_cursor || '');
      setActivityLoaded(true);
    } catch (loadError) {
      if (version === activityRequest.current) {
        setOverviewErrors(current => ({ ...current, timeline: loadError.message || t('work.loadActivityFailed') }));
      }
    } finally {
      if (version === activityRequest.current) setActivityLoading(false);
    }
  }, [t, workId]);

  useEffect(() => {
    setDetail(null);
    setOverview(EMPTY_OVERVIEW);
    setOverviewErrors({});
    setTimeline([]);
    setTimelineCursor('');
    setTimelineKind('');
    setActivityLoaded(false);
    setProcessVisited(Boolean(initialRunId));
    setRunsPage(1);
    setActiveDeliveryId(selectedHandoffId);
    setEditorOpen(false);
    setPendingAction('');
    setReviewAction('');
    setReviewRequest(null);
    setReviewComment('');
    loadDetail();
    loadOverview();
  }, [loadDetail, loadOverview, selectedHandoffId, initialRunId]);

  useEffect(() => {
    if (processVisited && !activityLoaded && !activityLoading) loadActivity();
  }, [processVisited, activityLoaded, activityLoading, loadActivity]);

  const work = detail?.work || null;
  const projectName = projects.find(project => project.id === work?.owner?.project_id)?.name || work?.owner?.project_id || 'Unscoped';
  const decision = detail?.decision || null;
  const availableActions = workAvailableActions(work?.status, decision);
  const feedbackPending = ['received', 'executing'].includes(detail?.feedback?.status);
  useEffect(() => {
    if (!feedbackPending || reviewAction) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadDetail({ silent: true });
      void loadOverview();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [feedbackPending, loadDetail, loadOverview, reviewAction]);
  const visibleTimeline = useMemo(() => filterTimelineItems(timeline, timelineKind), [timeline, timelineKind]);
  const customAcceptance = useMemo(
    () => (work?.acceptance?.criteria || []).filter(criterion => criterion.id !== DEFAULT_ACCEPTANCE_ID),
    [work],
  );

  useEffect(() => {
    setActiveDeliveryId(current => selectedHandoffId
      || (overview.handoffs.some(item => item.id === current) ? current : overview.handoffs[0]?.id || ''));
  }, [overview.handoffs, selectedHandoffId]);

  useEffect(() => {
    if (!work) return;
    onPageContextChange?.({
      page_id: 'work',
      project_id: work.owner?.project_id || '',
      work_id: work.id,
      ...(activeDeliveryId
        ? { handoff_id: activeDeliveryId }
        : {}),
    });
  }, [activeDeliveryId, onPageContextChange, work]);

  useEffect(() => {
    let timer = 0;
    const refresh = () => { if (timer) return;timer = setTimeout(() => { timer = 0;loadDetail({ silent: true });loadOverview(); }, 300); };
    const unsubscribe = eventsApi.subscribeToEvents(event => { if (String(event.type).startsWith('issue.')) refresh(); });
    const interval = setInterval(() => { if (document.visibilityState === 'visible' && work?.status === 'in_progress') refresh(); }, 5000);
    return () => { clearTimeout(timer);clearInterval(interval);unsubscribe(); };
  }, [loadDetail, loadOverview, work?.status]);

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([loadDetail({ silent: true }), loadOverview(), ...(activityLoaded ? [loadActivity()] : [])]);
    setRefreshing(false);
  };

  const loadMoreTimeline = async () => {
    if (!timelineCursor || timelineLoadingMore) return;
    setTimelineLoadingMore(true);
    try {
      const response = await workApi.getWorkTimeline(workId, { cursor: timelineCursor, limit: 60 });
      setTimeline(current => mergeTimelinePages(current, response?.items || []));
      setTimelineCursor(response?.next_cursor || '');
      setOverviewErrors(current => ({ ...current, timeline: '' }));
    } catch (timelineError) {
      setOverviewErrors(current => ({ ...current, timeline: timelineError.message || t('work.loadMoreActivityFailed') }));
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

  const submitReview = async () => {
    const comment = reviewComment;
    if (!work || submitting || ((reviewAction === 'reject' || reviewAction === 'request_changes') && !comment.trim())) return;
    setSubmitting(true);
    try {
      await workApi.answerWorkHumanReview(work.id, {
        action: reviewAction,
        comment,
        review_request_id: reviewRequest?.id,
        review_revision: reviewRequest?.revision,
      });
      message.success(t('work.reviewSubmitted'));
      setReviewAction('');
      setReviewComment('');
      await refreshAll();
      onWorkChanged?.();
    } catch (reviewError) {
      message.error(reviewError.message || t('work.reviewFailed'));
      if (reviewError.status === 409) { setReviewAction(''); await refreshAll(); }
    } finally {
      setSubmitting(false);
    }
  };

  const selectReview = (action) => {
    setReviewRequest(decision?.request || null);
    setReviewAction(action);
  };

  if (loading && !work) return <WorkDetailLoading />;
  if (error || !work) return <WorkDetailFailure error={error} navigateTo={navigateTo} />;

  const latestRun = overview.runs[0];
  const profileSummary = workProfileSummary(work, latestRun);
  const loadEarlierResult = async kind => {
    try {
      const response = kind === 'evidence'
        ? await evidenceApi.listEvidence({ cursor: resultCursors.evidence, limit: 20, workId })
        : await handoffsApi.getHandoffs({ cursor: resultCursors.handoffs, limit: 10, workId });
      setOverview(current => ({ ...current, [kind]: [...current[kind], ...(response.items || [])] }));
      setResultCursors(current => ({ ...current, [kind]: response.next_cursor || '' }));
    } catch (error) { message.error(error.message || '读取更早结果失败'); }
  };
  const loadEarlierRuns = async () => {
    try {
      const result = await runsApi.getRuns({ page: runsPage + 1, pageSize: 10, workId });
      setOverview(current => ({ ...current, runs: [...current.runs, ...(result.items || [])] }));
      setRunsPage(current => current + 1);
      setRunsMore((runsPage + 1) * 10 < Number(result.total || 0));
    } catch (error) { message.error(error.message || '读取更早执行失败'); }
  };

  return (
    <section className="work-detail-page animate-fade-in">
      <div className="work-detail-toolbar">
        <button className="work-detail-back" onClick={() => navigateTo('work')} type="button"><ArrowLeft size={15} /> {t('work.board')}</button>
        <div className="work-detail-actions">

          {availableActions.start ? <button className="primary" disabled={submitting} onClick={() => submitAction('enqueue')} type="button"><Play size={14} /> {t('work.start')}</button> : null}
          {availableActions.retry ? <button className="primary" disabled={submitting} onClick={() => work.status === 'in_progress' ? setPendingAction('retry') : submitAction('retry')} type="button"><RotateCw size={14} /> {t('work.retry')}</button> : null}
          <details className="work-detail-more"><summary>更多</summary><div>
            {availableActions.edit && <button onClick={() => setEditorOpen(true)} type="button"><Pencil size={14}/>编辑</button>}
            {availableActions.cancel && <button className="danger" disabled={submitting} onClick={() => setPendingAction('cancel')} type="button"><Square size={13}/>取消</button>}
            <button onClick={() => navigator.clipboard.writeText(work.id).then(() => message.success('任务 ID 已复制')).catch(error => message.error(error.message))} type="button">复制任务 ID</button>
          </div></details>
          <button disabled={refreshing} onClick={refreshAll} type="button"><RefreshCw className={refreshing ? 'is-spinning' : ''} size={14} /> {t('work.refresh')}</button>
        </div>
      </div>

      <header className="work-detail-hero">
        <div className="work-detail-hero-main">
          <div className="work-detail-eyebrow">TASK</div>
          <div className="work-detail-title-row">
            <span className="work-detail-status" data-status={work.status}>{t(`status.${work.status}`)}</span>
            <h1>{work.title}</h1>
          </div>
          <div className="work-detail-meta"><span>{projectName}</span><span>{t('work.updated', { time: formatTime(work.updated_at, language) })}</span></div>
        </div>

      </header>

      {pendingAction ? <InlineConfirmation action={pendingAction} busy={submitting} onCancel={() => setPendingAction('')} onConfirm={() => submitAction(pendingAction)} /> : null}
      <section className="work-detail-panel work-current-state">
        <SectionHeading eyebrow="NOW" title="现在怎样" />
        {workBlockReason(work, projects.find(project => project.id === work.owner?.project_id)) && <p role="status">{workBlockReason(work, projects.find(project => project.id === work.owner?.project_id))}</p>}
        <WorkStateSummary status={work.status} decision={decision} />
        <WorkFeedback feedback={detail?.feedback} />
        <InboxRequests embedded workId={workId} navigateTo={navigateTo} />
        {availableActions.review ? <HumanReviewCard disabled={submitting} onSelect={selectReview} request={decision.request} /> : null}
        <details className="work-custom-acceptance"><summary>任务描述</summary><MarkdownPreview text={work.goal || t('work.noGoal')} /></details>
        {customAcceptance.length > 0 && <details className="work-custom-acceptance"><summary>{t('work.acceptanceCriteria')}</summary><ul>{customAcceptance.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul></details>}
      </section>
      {(overview.handoffs.length > 0 || overview.evidence.length > 0 || overviewErrors.evidence || overviewErrors.handoffs) && <section className="work-detail-panel work-delivery-panel">
        <SectionHeading eyebrow="RESULT" title="结果" />
        <WorkDeliveryView evidence={overview.evidence} handoffs={overview.handoffs} loading={overviewLoading} loadError={overviewErrors.evidence || overviewErrors.handoffs} onRefresh={refreshAll} onSelectionChange={setActiveDeliveryId} selectedHandoffId={activeDeliveryId} work={work} />
        {Object.entries(resultCursors).map(([kind,cursor]) => cursor && <button className="btn btn-secondary" key={kind} onClick={() => loadEarlierResult(kind)} type="button">{kind === 'evidence' ? '更早验证结果' : '更早交付结果'}</button>)}
      </section>}
      <details className="work-process-disclosure" open={initialRunId ? true : undefined} onToggle={event => { if (event.currentTarget.open) setProcessVisited(true); }}>
        <summary>过程</summary>
        {processVisited && <div>
          <ResourceError error={overviewErrors.runs} />
          {overview.runs.map((run, index) => <details className="work-run-disclosure" key={run.id} open={run.id === initialRunId ? true : undefined}><summary>第 {Number(run.sequence || runsTotal - index)} 次执行 · {run.status}</summary><LazyTaskRun run={run} projects={projects} navigateTo={navigateTo} workId={workId} /></details>)}
          {initialRunId && !overview.runs.some(run => run.id === initialRunId) && <details className="work-run-disclosure" open><summary>指定执行</summary><LazyTaskRun run={{ id: initialRunId }} projects={projects} navigateTo={navigateTo} workId={workId} /></details>}
          {runsMore && <button className="btn btn-secondary" onClick={loadEarlierRuns} type="button">更早执行</button>}
          {!overview.runs.length && <EmptySection text={t('work.noRun')} />}
          <details className="work-provider-profile-panel"><summary>执行配置</summary>
            <dl className="work-provider-profile-facts"><div><dt>执行预设</dt><dd>{profileSummary.effectiveProfile}</dd></div><div><dt>编程工具</dt><dd>{profileSummary.effectiveProvider}</dd></div><div><dt>模型</dt><dd>{profileSummary.effectiveModel}</dd></div><div><dt>来源</dt><dd>{profileSummary.source === 'work' ? '任务指定' : '项目默认'}</dd></div><div><dt>最近实际工具</dt><dd>{profileSummary.runProvider}</dd></div></dl>
          </details>
          <section className="work-activity-panel"><SectionHeading eyebrow="HISTORY" title="活动时间线" />
            <div className="work-timeline-filters" role="group" aria-label={t('work.activityKind')}><button aria-pressed={!timelineKind} onClick={() => setTimelineKind('')} type="button">全部</button>{WORK_TIMELINE_KINDS.map(kind => <button aria-pressed={timelineKind === kind} key={kind} onClick={() => setTimelineKind(kind)} type="button">{t(`timeline.${kind}`)}</button>)}</div>
            <ResourceError error={overviewErrors.timeline} />
            {activityLoading && !activityLoaded && <p role="status">正在读取活动…</p>}
            <div className="work-timeline-list">{visibleTimeline.map(item => <article key={item.id}><span className="work-timeline-marker" data-kind={item.kind}/><div><strong>{item.title}</strong><p>{item.summary}</p><span>{formatTime(item.occurred_at, language)}</span></div></article>)}</div>
            {timelineCursor && <button className="work-timeline-more" disabled={timelineLoadingMore} onClick={loadMoreTimeline} type="button">更早活动</button>}
          </section>
        </div>}
      </details>

      {editorOpen ? <WorkEditorDialog mode="edit" onClose={() => setEditorOpen(false)} onSaved={async () => { setEditorOpen(false); await refreshAll(); onWorkChanged?.(); }} projects={projects} work={work} /> : null}
      {reviewAction ? <ReviewDialog action={reviewAction} busy={submitting} comment={reviewComment} onCancel={() => { setReviewAction(''); setReviewComment(''); }} onChange={setReviewComment} onConfirm={submitReview} request={reviewRequest} /> : null}
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

function HumanReviewCard({ disabled, onSelect, request }) {
  const { t } = useI18n();
  const copy = workHumanReviewCopy(request.kind, t);
  return <article className="work-human-review-card">
    <span>{t('work.youAreApproving')}</span>
    <h3>{request.question}</h3>

    {request.recommendation ? <p><strong>{t('work.piRecommendation')}：</strong>{request.recommendation}</p> : null}
    {request.acceptance_summary?.length ? <div><strong>{t('work.acceptanceIncludes')}</strong><ul>{request.acceptance_summary.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
    {request.excluded_scope?.length ? <div><strong>{t('work.notIncluded')}</strong><ul>{request.excluded_scope.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
    {request.evidence_refs?.length ? <details><summary>{t('work.reviewEvidence')}</summary><ul>{request.evidence_refs.map(item => <li key={item}><code>{item}</code></li>)}</ul></details> : null}
    {request.consequences ? <p><strong>{t('work.approvalConsequences')}：</strong>{request.consequences}</p> : null}
    <div className="work-review-actions"><button disabled={disabled} onClick={() => onSelect('accept')} type="button"><CheckCircle2 size={14} /> {copy.accept}</button>{request.kind !== 'risk_acceptance' && <button disabled={disabled} onClick={() => onSelect('request_changes')} type="button"><RefreshCw size={14} /> {t('work.changes')}</button>}{request.kind !== 'acceptance' && <button className="danger" disabled={disabled} onClick={() => onSelect('reject')} type="button"><XCircle size={14} /> {t('work.reject')}</button>}</div>
  </article>;
}

function InlineConfirmation({ action, busy, onCancel, onConfirm }) {
  const { t } = useI18n();
  return <div className="work-inline-confirm" role="alertdialog" aria-label={action === 'retry' ? '确认重试任务？' : t('work.confirmCancel')}><AlertTriangle size={18} /><div><strong>{action === 'retry' ? '确认重试任务？' : t('work.confirmCancel')}</strong><span>{action === 'retry' ? '将中断当前执行并重新排队。' : t('work.cancelAudit')}</span></div><button disabled={busy} onClick={onCancel} type="button">{t('work.keep')}</button><button className="danger" disabled={busy} onClick={onConfirm} type="button">{busy ? t('work.submitting') : action === 'retry' ? '确认重试' : t('work.confirmCancelAction')}</button></div>;
}

function ReviewDialog({ action, busy, comment, onCancel, onChange, onConfirm, request }) {
  const { t } = useI18n();
  const copy = workHumanReviewCopy(request?.kind, t);
  const commentRequired = action === 'reject' || action === 'request_changes';
  return <ModalOverlay className="work-dialog-overlay"><form className="work-review-dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}><span>{t('work.reviewGate')}</span><h2>{reviewTitle(action, t, copy)}</h2><p className="work-review-question">{request?.question}</p><p>{action === 'request_changes' ? t('work.reviewRevisionFlow') : action === 'accept' ? copy.detail : t('work.reviewAudit')}</p><label><span>{t(commentRequired ? 'work.reviewNoteRequired' : 'work.reviewNoteOptional')}</span><textarea autoFocus={commentRequired} className="form-control" onChange={event => onChange(event.target.value)} placeholder={action === 'request_changes' ? t('work.reviewChangesPlaceholder') : ''} rows={5} value={comment} /></label><div><button disabled={busy} onClick={onCancel} type="button">{t('work.cancel')}</button><button className={action === 'reject' ? 'danger' : 'primary'} disabled={busy || (commentRequired && !comment.trim())} type="submit">{busy ? t('work.submitting') : action === 'request_changes' ? t('work.submitChangesAndContinue') : action === 'accept' ? copy.accept : t('work.submitReview')}</button></div></form></ModalOverlay>;
}

function fulfilledItems(result) {
  if (result.status !== 'fulfilled') return [];
  if (Array.isArray(result.value)) return result.value;
  return result.value?.items || [];
}

function settledErrors(results, keys) {
  return Object.fromEntries(results.flatMap((result, index) => result.status === 'rejected' ? [[keys[index], result.reason?.message || `Failed to load ${keys[index]}`]] : []));
}

function reviewTitle(action, t, copy) {
  if (action === 'accept') return copy.title;
  if (action === 'reject') return copy.reject;
  return t('work.requestChanges');
}

function formatTime(value, language) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(language) : value;
}

function LazyTaskRun({ run, projects, navigateTo, workId }) {
  const [visited, setVisited] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const details = ref.current?.parentElement;
    const onToggle = () => { if (details?.open) setVisited(true); };
    details?.addEventListener('toggle', onToggle);onToggle();
    return () => details?.removeEventListener('toggle', onToggle);
  }, []);
  return <div ref={ref}>{visited && <TaskRunProcess runId={run.id} expectedWorkId={workId} project={projects.find(project=>project.id===run.project_id)} navigateTo={navigateTo}/>}</div>;
}

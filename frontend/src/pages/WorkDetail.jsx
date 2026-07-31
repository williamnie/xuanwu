import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
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
import { runsApi } from '../api/runs.js';
import { workApi } from '../api/work.js';
import MarkdownPreview from '../components/editor/MarkdownPreview.jsx';
import { message } from '../store/toastStore.js';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import { workProfileSummary } from './work/workProfileRouting.js';
import WorkDeliveryView from './work/WorkDeliveryView.jsx';
import { handoffHref } from './handoffPageModel.js';
import { issueIdFromWorkId } from './workBoardModel.js';
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

export default function WorkDetail({ navigateTo, onPageContextChange, onWorkChanged, projects = [], selectedHandoffId = '', workId }) {
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
  const [activeView, setActiveView] = useState(selectedHandoffId ? 'delivery' : 'overview');
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
    setActiveView(selectedHandoffId ? 'delivery' : 'overview');
    setActiveDeliveryId(selectedHandoffId);
    setEditorOpen(false);
    setPendingAction('');
    setReviewAction('');
    setReviewComment('');
    loadDetail();
    loadOverview();
  }, [loadDetail, loadOverview, selectedHandoffId]);

  useEffect(() => {
    if (activeView === 'activity' && !activityLoaded && !activityLoading) loadActivity();
  }, [activeView, activityLoaded, activityLoading, loadActivity]);

  const work = detail?.work || null;
  const issueId = issueIdFromWorkId(work?.id);
  const projectName = projects.find(project => project.id === work?.owner?.project_id)?.name || work?.owner?.project_id || 'Unscoped';
  const verification = detail?.verification || null;
  const availableActions = workAvailableActions(work?.status, verification);
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
      ...(activeView === 'delivery' && activeDeliveryId
        ? { handoff_id: activeDeliveryId }
        : {}),
    });
  }, [activeDeliveryId, activeView, onPageContextChange, work]);

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
    const comment = reviewComment.trim();
    if (!work || submitting || ((reviewAction === 'reject' || reviewAction === 'request_changes') && !comment)) return;
    setSubmitting(true);
    try {
      await workApi.reviewWork(work.id, {
        action: reviewAction,
        comment,
        review_request_id: verification?.request?.id,
        review_revision: verification?.request?.revision,
      });
      message.success(t('work.reviewSubmitted'));
      setReviewAction('');
      setReviewComment('');
      await refreshAll();
      onWorkChanged?.();
    } catch (reviewError) {
      message.error(reviewError.message || t('work.reviewFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !work) return <WorkDetailLoading />;
  if (error || !work) return <WorkDetailFailure error={error} navigateTo={navigateTo} />;

  const latestRun = overview.runs[0];
  const profileSummary = workProfileSummary(work, latestRun);
  const latestHandoff = overview.handoffs[0];
  const passedEvidence = overview.evidence.filter(item => item.status === 'passed').length;
  const failedEvidence = overview.evidence.filter(item => item.status === 'failed').length;
  const selectView = (view) => {
    setActiveView(view);
    if (typeof window === 'undefined') return;
    if (view === 'delivery' && latestHandoff) {
      window.history.replaceState(null, '', handoffHref(activeDeliveryId || latestHandoff.id, work.id));
    } else if (window.location.hash.startsWith('#/work/')) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  };

  return (
    <section className="work-detail-page animate-fade-in">
      <div className="work-detail-toolbar">
        <button className="work-detail-back" onClick={() => navigateTo('work')} type="button"><ArrowLeft size={15} /> {t('work.board')}</button>
        <div className="work-detail-actions">
          {availableActions.edit ? <button onClick={() => setEditorOpen(true)} type="button"><Pencil size={14} /> {t('work.edit')}</button> : null}
          {availableActions.start ? <button className="primary" disabled={submitting} onClick={() => submitAction('enqueue')} type="button"><Play size={14} /> {t('work.start')}</button> : null}
          {availableActions.retry ? <button className="primary" disabled={submitting} onClick={() => submitAction('retry')} type="button"><RotateCw size={14} /> {t('work.retry')}</button> : null}
          {availableActions.cancel ? <button className="danger" disabled={submitting} onClick={() => setPendingAction('cancel')} type="button"><Square size={13} /> {t('work.cancel')}</button> : null}
          <button disabled={refreshing} onClick={refreshAll} type="button"><RefreshCw className={refreshing ? 'is-spinning' : ''} size={14} /> {t('work.refresh')}</button>
        </div>
      </div>

      <header className="work-detail-hero">
        <div className="work-detail-hero-main">
          <div className="work-detail-eyebrow"><CircleDot size={13} /> Work</div>
          <div className="work-detail-title-row">
            <span className="work-detail-status" data-status={work.status}>{t(`status.${work.status}`)}</span>
            <h1>{work.title}</h1>
          </div>
          <div className="work-detail-meta"><span>{projectName}</span><span>{t('work.updated', { time: formatTime(work.updated_at, language) })}</span></div>
        </div>
        <div className="work-detail-identity"><span>WORK ID</span><code>{work.id}</code>{issueId ? <span>Issue #{issueId}</span> : null}</div>
      </header>

      <nav className="work-detail-view-tabs" aria-label={t('work.detailViews')}>
        <button aria-current={activeView === 'overview' ? 'page' : undefined} onClick={() => selectView('overview')} type="button">{t('work.overview')}</button>
        <button aria-current={activeView === 'delivery' ? 'page' : undefined} onClick={() => selectView('delivery')} type="button">{t('work.delivery')} {overview.handoffs.length > 0 ? `(${overview.handoffs.length})` : ''}</button>
        <button aria-current={activeView === 'activity' ? 'page' : undefined} onClick={() => selectView('activity')} type="button">{t('work.activity')}</button>
      </nav>

      {pendingAction ? <InlineConfirmation busy={submitting} onCancel={() => setPendingAction('')} onConfirm={() => submitAction(pendingAction)} /> : null}

      {activeView === 'overview' ? (
        <div className="work-overview-layout">
          <section className="work-detail-panel work-detail-goal">
            <SectionHeading eyebrow={t('work.task')} title={t('work.goal')} />
            <MarkdownPreview text={work.goal || t('work.noGoal')} />
          </section>

          <div className="work-overview-grid">
            <section className="work-detail-panel">
              <SectionHeading eyebrow={t('work.current')} title={t('work.nextStep')} />
              <WorkStateSummary status={work.status} verification={verification} />
              {availableActions.review ? <HumanReviewCard disabled={submitting} onSelect={setReviewAction} request={verification.request} /> : null}
            </section>

            <section className="work-detail-panel">
              <SectionHeading eyebrow={overviewLoading ? t('work.loading') : t('work.runsCount', { count: overview.runs.length })} title={t('work.latestRun')} />
              <ResourceError error={overviewErrors.runs} />
              {latestRun ? <LatestRunCard navigateTo={navigateTo} run={latestRun} /> : <EmptySection text={t('work.noRun')} />}
            </section>

            <section className="work-detail-panel work-provider-profile-panel">
              <SectionHeading eyebrow="Execution routing" title="Agent Profile / Provider" />
              <dl className="work-provider-profile-facts">
                <div><dt>Work selection</dt><dd>{profileSummary.selection}</dd></div>
                <div><dt>Effective profile</dt><dd>{profileSummary.effectiveProfile}</dd></div>
                <div><dt>Effective provider</dt><dd>{profileSummary.effectiveProvider}</dd></div>
                <div><dt>Effective model</dt><dd>{profileSummary.effectiveModel}</dd></div>
                <div><dt>Selection source</dt><dd>{profileSummary.source}</dd></div>
                <div><dt>Latest Run actual provider</dt><dd>{profileSummary.runProvider}</dd></div>
              </dl>
            </section>

            <section className="work-detail-panel">
              <SectionHeading eyebrow={t('work.verification')} title={t('work.delivery')} />
              <ResourceError error={overviewErrors.evidence || overviewErrors.handoffs} />
              <div className="work-delivery-facts">
                <span><strong>{passedEvidence}</strong> {t('work.passedEvidence')}</span>
                <span className={failedEvidence ? 'failed' : ''}><strong>{failedEvidence}</strong> {t('work.failedEvidence')}</span>
              </div>
              {latestHandoff
                ? <LatestHandoffCard handoff={latestHandoff} onOpen={() => selectView('delivery')} />
                : <EmptySection text={handoffEmptyText(work)} />}
            </section>
          </div>

          {customAcceptance.length ? (
            <details className="work-custom-acceptance">
              <summary>{t('work.acceptanceCriteria')} ({customAcceptance.length})</summary>
              <ul>{customAcceptance.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul>
            </details>
          ) : null}
        </div>
      ) : activeView === 'delivery' ? (
        <section className="work-detail-panel work-delivery-panel">
          <WorkDeliveryView
            evidence={overview.evidence}
            handoffs={overview.handoffs}
            loading={overviewLoading}
            loadError={overviewErrors.evidence || overviewErrors.handoffs}
            onRefresh={loadOverview}
            onSelectionChange={setActiveDeliveryId}
            selectedHandoffId={activeDeliveryId}
            work={work}
          />
        </section>
      ) : (
        <section className="work-detail-panel work-activity-panel">
          <SectionHeading eyebrow={t('work.boundedHistory')} title={t('work.activity')} />
          <div className="work-timeline-filters" role="group" aria-label={t('work.activityKind')}>
            <button aria-pressed={!timelineKind} onClick={() => setTimelineKind('')} type="button">{t('work.all')}</button>
            {WORK_TIMELINE_KINDS.map(kind => <button aria-pressed={timelineKind === kind} key={kind} onClick={() => setTimelineKind(kind)} type="button">{t(`timeline.${kind}`)}</button>)}
          </div>
          <ResourceError error={overviewErrors.timeline} />
          {activityLoading && !activityLoaded ? <div className="work-activity-loading"><LoaderCircle className="is-spinning" size={18} /> {t('work.loadingActivity')}</div> : null}
          {!activityLoading && visibleTimeline.length === 0 ? <EmptySection text={timelineKind ? t('work.noMatchingActivity') : t('work.noActivity')} /> : null}
          <div className="work-timeline-list">
            {visibleTimeline.map(item => (
              <article key={item.id}>
                <span className="work-timeline-marker" data-kind={item.kind} />
                <div><div><strong>{item.title}</strong><em>{item.status}</em></div><p>{item.summary}</p><span>{t(`timeline.${item.kind}`)} · {formatTime(item.occurred_at, language)}</span></div>
              </article>
            ))}
          </div>
          {timelineCursor ? <button className="work-timeline-more" disabled={timelineLoadingMore} onClick={loadMoreTimeline} type="button">{timelineLoadingMore ? <LoaderCircle className="is-spinning" size={14} /> : null}{timelineLoadingMore ? t('work.loadingEarlier') : t('work.loadEarlier')}</button> : null}
        </section>
      )}

      {editorOpen ? <WorkEditorDialog mode="edit" onClose={() => setEditorOpen(false)} onSaved={async () => { setEditorOpen(false); await refreshAll(); onWorkChanged?.(); }} projects={projects} work={work} /> : null}
      {reviewAction ? <ReviewDialog action={reviewAction} busy={submitting} comment={reviewComment} onCancel={() => { setReviewAction(''); setReviewComment(''); }} onChange={setReviewComment} onConfirm={submitReview} request={verification?.request} /> : null}
    </section>
  );
}

function LatestRunCard({ navigateTo, run }) {
  const { language, t } = useI18n();
  return <article className="work-latest-run"><div><em data-status={run.status}>{t(`status.${run.status}`)}</em><span>{run.provider || 'unknown'} · {formatTime(run.started_at, language)}</span></div><strong>{run.progress?.latest?.summary || run.terminal?.reason || t('work.noProgress')}</strong><button onClick={() => navigateTo('runs', null, run.id)} type="button">{t('work.openRun')} <ArrowUpRight size={12} /></button></article>;
}

function LatestHandoffCard({ handoff, onOpen }) {
  const { t } = useI18n();
  const status = handoff.delivery_status?.overall || handoff.status;
  const mode = {
    branch_commit: t('work.handoff.localCommit'),
    deploy: t('work.handoff.deploy'),
    draft_pr: t('work.handoff.draftPr'),
    local_changes: t('work.handoff.localChanges'),
    push: t('work.handoff.push'),
    ready_pr: t('work.handoff.readyPr'),
    release: t('work.handoff.release'),
  }[handoff.delivery?.mode] || handoff.delivery?.mode || t('work.handoff.credential');
  return <article className="work-latest-handoff"><div><strong>{mode}</strong><em data-status={status}>{status === 'ready' ? t('work.handoff.ready') : status}</em></div><p>{t('work.handoff.summary', { files: handoff.changed_file_count, evidence: handoff.evidence_count, risks: handoff.risk_count })}</p><button onClick={onOpen} type="button">{t('work.handoff.open')} <ArrowUpRight size={12} /></button></article>;
}

function WorkStateSummary({ status, verification }) {
  const { t } = useI18n();
  const pendingSummary = verification?.owner === 'human'
    ? [t('work.state.reviewTitle'), verification?.request?.question || t('work.state.reviewDetail')]
    : verification?.phase === 'pi_repairing'
      ? [t('work.state.piRepairingTitle'), t('work.state.piRepairingDetail')]
      : [t('work.state.piVerifyingTitle'), t('work.state.piVerifyingDetail')];
  const summary = {
    cancelled: [t('work.state.cancelledTitle'), t('work.state.cancelledDetail')],
    done: [t('work.state.doneTitle'), t('work.state.doneDetail')],
    failed: [t('work.state.failedTitle'), t('work.state.failedDetail')],
    in_progress: [t('work.state.runningTitle'), t('work.state.runningDetail')],
    pending_verification: pendingSummary,
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
  return <article className="work-human-review-card">
    <span>{t('work.youAreApproving')}</span>
    <h3>{request.question}</h3>
    {request.recommendation ? <p><strong>{t('work.piRecommendation')}：</strong>{request.recommendation}</p> : null}
    {request.acceptance_summary?.length ? <div><strong>{t('work.acceptanceIncludes')}</strong><ul>{request.acceptance_summary.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
    {request.excluded_scope?.length ? <div><strong>{t('work.notIncluded')}</strong><ul>{request.excluded_scope.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
    {request.evidence_refs?.length ? <details><summary>{t('work.reviewEvidence')}</summary><ul>{request.evidence_refs.map(item => <li key={item}><code>{item}</code></li>)}</ul></details> : null}
    {request.consequences ? <p><strong>{t('work.approvalConsequences')}：</strong>{request.consequences}</p> : null}
    <div className="work-review-actions"><button disabled={disabled} onClick={() => onSelect('accept')} type="button"><CheckCircle2 size={14} /> {t('work.accept')}</button><button disabled={disabled} onClick={() => onSelect('request_changes')} type="button"><RefreshCw size={14} /> {t('work.changes')}</button><button className="danger" disabled={disabled} onClick={() => onSelect('reject')} type="button"><XCircle size={14} /> {t('work.reject')}</button></div>
  </article>;
}

function InlineConfirmation({ busy, onCancel, onConfirm }) {
  const { t } = useI18n();
  return <div className="work-inline-confirm" role="alertdialog" aria-label={t('work.confirmCancel')}><AlertTriangle size={18} /><div><strong>{t('work.confirmCancel')}</strong><span>{t('work.cancelAudit')}</span></div><button disabled={busy} onClick={onCancel} type="button">{t('work.keep')}</button><button className="danger" disabled={busy} onClick={onConfirm} type="button">{busy ? t('work.submitting') : t('work.confirmCancelAction')}</button></div>;
}

function ReviewDialog({ action, busy, comment, onCancel, onChange, onConfirm, request }) {
  const { t } = useI18n();
  const commentRequired = action === 'reject' || action === 'request_changes';
  return <div className="modal-overlay work-dialog-overlay"><form className="work-review-dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}><span>{t('work.reviewGate')}</span><h2>{reviewTitle(action, t)}</h2><p className="work-review-question">{request?.question}</p><p>{action === 'request_changes' ? t('work.reviewRevisionFlow') : t('work.reviewAudit')}</p><label><span>{t(commentRequired ? 'work.reviewNoteRequired' : 'work.reviewNoteOptional')}</span><textarea autoFocus={commentRequired} className="form-control" onChange={event => onChange(event.target.value)} placeholder={action === 'request_changes' ? t('work.reviewChangesPlaceholder') : ''} rows={5} value={comment} /></label><div><button disabled={busy} onClick={onCancel} type="button">{t('work.cancel')}</button><button className={action === 'reject' ? 'danger' : 'primary'} disabled={busy || (commentRequired && !comment.trim())} type="submit">{busy ? t('work.submitting') : action === 'request_changes' ? t('work.submitChangesAndContinue') : t('work.submitReview')}</button></div></form></div>;
}

function fulfilledItems(result) {
  if (result.status !== 'fulfilled') return [];
  if (Array.isArray(result.value)) return result.value;
  return result.value?.items || [];
}

function settledErrors(results, keys) {
  return Object.fromEntries(results.flatMap((result, index) => result.status === 'rejected' ? [[keys[index], result.reason?.message || `Failed to load ${keys[index]}`]] : []));
}

function reviewTitle(action, t) {
  if (action === 'accept') return t('work.acceptDelivery');
  if (action === 'reject') return t('work.rejectDelivery');
  return t('work.requestChanges');
}

function formatTime(value, language) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(language) : value;
}

function handoffEmptyText(work) {
  const policy = work?.acceptance?.handoff_policy
    || (work?.acceptance?.requires_handoff ? 'required' : 'summary');
  if (policy === 'none') return '此 Work 不要求 Handoff；Evidence 仍是完成门禁。';
  if (policy === 'summary') return work?.status === 'done'
    ? '此 Work 使用 summary 策略，未生成独立 Handoff 不阻塞完成。'
    : 'Handoff 摘要会在有复用价值时生成，不阻塞完成。';
  return '完成必须具备 ready 或 delivered Handoff。';
}

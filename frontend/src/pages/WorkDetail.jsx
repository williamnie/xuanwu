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

const STATUS_LABELS = {
  cancelled: 'Cancelled',
  done: 'Done',
  failed: 'Failed',
  in_progress: 'In progress',
  pending_verification: 'Verification',
  todo: 'Todo',
  triage: 'Triage',
};

const TIMELINE_LABELS = {
  approval: 'Attention',
  evidence: 'Evidence',
  handoff: 'Handoff',
  issue_event: 'Issue event',
  run: 'Run',
  work_event: 'Work audit',
};

const EMPTY_OVERVIEW = { evidence: [], handoffs: [], runs: [] };
const DEFAULT_ACCEPTANCE_ID = 'issue-delivery';

export default function WorkDetail({ navigateTo, onPageContextChange, onWorkChanged, projects = [], selectedHandoffId = '', workId }) {
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
      if (version === detailRequest.current) setError(loadError.message || '加载 Work 详情失败');
    } finally {
      if (version === detailRequest.current) setLoading(false);
    }
  }, [workId]);

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
        setOverviewErrors(current => ({ ...current, timeline: loadError.message || '加载 Activity 失败' }));
      }
    } finally {
      if (version === activityRequest.current) setActivityLoading(false);
    }
  }, [workId]);

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
  const availableActions = workAvailableActions(work?.status);
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
      setOverviewErrors(current => ({ ...current, timeline: timelineError.message || '加载更多 Activity 失败' }));
    } finally {
      setTimelineLoadingMore(false);
    }
  };

  const submitAction = async (action) => {
    if (!work || submitting) return;
    setSubmitting(true);
    try {
      await workApi.controlWork(work.id, action, buildWorkActionPayload(work, action));
      message.success(action === 'enqueue' ? 'Work 已开始排队' : action === 'retry' ? 'Work 已重新排队' : 'Work 已取消');
      setPendingAction('');
      await refreshAll();
      onWorkChanged?.();
    } catch (actionError) {
      message.error(actionError.message || 'Work 操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  const submitReview = async () => {
    const comment = reviewComment.trim();
    if (!work || submitting || ((reviewAction === 'reject' || reviewAction === 'request_changes') && !comment)) return;
    setSubmitting(true);
    try {
      await workApi.reviewWork(work.id, { action: reviewAction, comment });
      message.success('Work 验收结论已审计提交');
      setReviewAction('');
      setReviewComment('');
      await refreshAll();
      onWorkChanged?.();
    } catch (reviewError) {
      message.error(reviewError.message || 'Work 验收失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !work) return <WorkDetailLoading />;
  if (error || !work) return <WorkDetailFailure error={error} navigateTo={navigateTo} />;

  const latestRun = overview.runs[0];
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
        <button className="work-detail-back" onClick={() => navigateTo('work')} type="button"><ArrowLeft size={15} /> Work Board</button>
        <div className="work-detail-actions">
          {availableActions.edit ? <button onClick={() => setEditorOpen(true)} type="button"><Pencil size={14} /> Edit</button> : null}
          {availableActions.start ? <button className="primary" disabled={submitting} onClick={() => submitAction('enqueue')} type="button"><Play size={14} /> Start</button> : null}
          {availableActions.retry ? <button className="primary" disabled={submitting} onClick={() => submitAction('retry')} type="button"><RotateCw size={14} /> Retry</button> : null}
          {availableActions.cancel ? <button className="danger" disabled={submitting} onClick={() => setPendingAction('cancel')} type="button"><Square size={13} /> Cancel</button> : null}
          <button disabled={refreshing} onClick={refreshAll} type="button"><RefreshCw className={refreshing ? 'is-spinning' : ''} size={14} /> Refresh</button>
        </div>
      </div>

      <header className="work-detail-hero">
        <div className="work-detail-hero-main">
          <div className="work-detail-eyebrow"><CircleDot size={13} /> Work</div>
          <div className="work-detail-title-row">
            <span className="work-detail-status" data-status={work.status}>{STATUS_LABELS[work.status] || work.status}</span>
            <h1>{work.title}</h1>
          </div>
          <div className="work-detail-meta"><span>{projectName}</span><span>Updated {formatTime(work.updated_at)}</span></div>
        </div>
        <div className="work-detail-identity"><span>WORK ID</span><code>{work.id}</code>{issueId ? <span>Issue #{issueId}</span> : null}</div>
      </header>

      <nav className="work-detail-view-tabs" aria-label="Work detail views">
        <button aria-current={activeView === 'overview' ? 'page' : undefined} onClick={() => selectView('overview')} type="button">Overview</button>
        <button aria-current={activeView === 'delivery' ? 'page' : undefined} onClick={() => selectView('delivery')} type="button">交付 {overview.handoffs.length > 0 ? `(${overview.handoffs.length})` : ''}</button>
        <button aria-current={activeView === 'activity' ? 'page' : undefined} onClick={() => selectView('activity')} type="button">Activity</button>
      </nav>

      {pendingAction ? <InlineConfirmation busy={submitting} onCancel={() => setPendingAction('')} onConfirm={() => submitAction(pendingAction)} /> : null}

      {activeView === 'overview' ? (
        <div className="work-overview-layout">
          <section className="work-detail-panel work-detail-goal">
            <SectionHeading eyebrow="Task" title="Goal" />
            <MarkdownPreview text={work.goal || 'No goal recorded.'} />
          </section>

          <div className="work-overview-grid">
            <section className="work-detail-panel">
              <SectionHeading eyebrow="Current" title="Next step" />
              <WorkStateSummary status={work.status} />
              {availableActions.review ? <ReviewActions disabled={submitting} onSelect={setReviewAction} /> : null}
            </section>

            <section className="work-detail-panel">
              <SectionHeading eyebrow={overviewLoading ? 'Loading' : `${overview.runs.length} runs`} title="Latest run" />
              <ResourceError error={overviewErrors.runs} />
              {latestRun ? <LatestRunCard navigateTo={navigateTo} run={latestRun} /> : <EmptySection text="No Run has been materialized." />}
            </section>

            <section className="work-detail-panel">
              <SectionHeading eyebrow="Verification" title="Delivery" />
              <ResourceError error={overviewErrors.evidence || overviewErrors.handoffs} />
              <div className="work-delivery-facts">
                <span><strong>{passedEvidence}</strong> passed Evidence</span>
                <span className={failedEvidence ? 'failed' : ''}><strong>{failedEvidence}</strong> failed Evidence</span>
              </div>
              {latestHandoff ? <LatestHandoffCard handoff={latestHandoff} onOpen={() => selectView('delivery')} /> : <EmptySection text={work.status === 'done' ? '历史完成记录没有可查询的 Handoff。' : '完成并通过验证后会生成交付凭证。'} />}
            </section>
          </div>

          {customAcceptance.length ? (
            <details className="work-custom-acceptance">
              <summary>Acceptance criteria ({customAcceptance.length})</summary>
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
          <SectionHeading eyebrow="Bounded history" title="Activity" />
          <div className="work-timeline-filters" role="group" aria-label="Activity kind">
            <button aria-pressed={!timelineKind} onClick={() => setTimelineKind('')} type="button">All</button>
            {WORK_TIMELINE_KINDS.map(kind => <button aria-pressed={timelineKind === kind} key={kind} onClick={() => setTimelineKind(kind)} type="button">{TIMELINE_LABELS[kind] || kind}</button>)}
          </div>
          <ResourceError error={overviewErrors.timeline} />
          {activityLoading && !activityLoaded ? <div className="work-activity-loading"><LoaderCircle className="is-spinning" size={18} /> Loading Activity…</div> : null}
          {!activityLoading && visibleTimeline.length === 0 ? <EmptySection text={timelineKind ? 'No Activity matches this filter.' : 'No Activity recorded.'} /> : null}
          <div className="work-timeline-list">
            {visibleTimeline.map(item => (
              <article key={item.id}>
                <span className="work-timeline-marker" data-kind={item.kind} />
                <div><div><strong>{item.title}</strong><em>{item.status}</em></div><p>{item.summary}</p><span>{TIMELINE_LABELS[item.kind] || item.kind} · {formatTime(item.occurred_at)}</span></div>
              </article>
            ))}
          </div>
          {timelineCursor ? <button className="work-timeline-more" disabled={timelineLoadingMore} onClick={loadMoreTimeline} type="button">{timelineLoadingMore ? <LoaderCircle className="is-spinning" size={14} /> : null}{timelineLoadingMore ? 'Loading…' : 'Load earlier'}</button> : null}
        </section>
      )}

      {editorOpen ? <WorkEditorDialog mode="edit" onClose={() => setEditorOpen(false)} onSaved={async () => { setEditorOpen(false); await refreshAll(); onWorkChanged?.(); }} projects={projects} work={work} /> : null}
      {reviewAction ? <ReviewDialog action={reviewAction} busy={submitting} comment={reviewComment} onCancel={() => { setReviewAction(''); setReviewComment(''); }} onChange={setReviewComment} onConfirm={submitReview} /> : null}
    </section>
  );
}

function LatestRunCard({ navigateTo, run }) {
  return <article className="work-latest-run"><div><em data-status={run.status}>{run.status}</em><span>{run.provider || 'unknown'} · {formatTime(run.started_at)}</span></div><strong>{run.progress?.latest?.summary || run.terminal?.reason || 'No progress summary yet.'}</strong><button onClick={() => navigateTo('runs', null, run.id)} type="button">Open Run <ArrowUpRight size={12} /></button></article>;
}

function LatestHandoffCard({ handoff, onOpen }) {
  const status = handoff.delivery_status?.overall || handoff.status;
  const mode = {
    branch_commit: '本地 commit 已创建',
    deploy: '部署交付',
    draft_pr: '草稿 PR',
    local_changes: '本地改动已记录',
    push: '代码已推送',
    ready_pr: 'PR 已准备好',
    release: '发布交付',
  }[handoff.delivery?.mode] || handoff.delivery?.mode || '交付凭证';
  return <article className="work-latest-handoff"><div><strong>{mode}</strong><em data-status={status}>{status === 'ready' ? '凭证已就绪' : status}</em></div><p>{handoff.changed_file_count} 个文件 · {handoff.evidence_count} 项 Evidence · {handoff.risk_count} 条风险</p><button onClick={onOpen} type="button">查看 Issue 交付 <ArrowUpRight size={12} /></button></article>;
}

function WorkStateSummary({ status }) {
  const summary = {
    cancelled: ['Cancelled', 'No automatic action is pending.'],
    done: ['Completed', '执行已完成；交付凭证和实际交付层级请查看“交付”。'],
    failed: ['Execution failed', 'Inspect the latest Run, then retry or edit the task.'],
    in_progress: ['Running', 'The runner owns the current execution.'],
    pending_verification: ['Review required', 'Accept the delivery or request focused changes.'],
    todo: ['Queued', 'Issue Loop will claim this Work automatically.'],
    triage: ['Ready to start', 'Start the Work or refine its goal.'],
  }[status] || [status, 'Inspect the latest Run for details.'];
  const Icon = status === 'failed' ? AlertTriangle : status === 'done' ? CheckCircle2 : CircleDot;
  return <div className="work-state-summary" data-status={status}><Icon size={18} /><div><strong>{summary[0]}</strong><span>{summary[1]}</span></div></div>;
}

function WorkDetailLoading() {
  return <div className="work-detail-loading"><LoaderCircle className="is-spinning" size={26} /><strong>Loading Work…</strong></div>;
}

function WorkDetailFailure({ error, navigateTo }) {
  return <section className="work-detail-failure" role="alert"><AlertTriangle size={22} /><div><strong>Work Detail 暂不可用</strong><span>{error || '找不到请求的 Work。'}</span></div><button onClick={() => navigateTo('work')} type="button"><ArrowLeft size={14} /> 返回 Work Board</button></section>;
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

function ReviewActions({ disabled, onSelect }) {
  return <div className="work-review-actions"><button disabled={disabled} onClick={() => onSelect('accept')} type="button"><CheckCircle2 size={14} /> Accept</button><button disabled={disabled} onClick={() => onSelect('request_changes')} type="button"><RefreshCw size={14} /> Changes</button><button className="danger" disabled={disabled} onClick={() => onSelect('reject')} type="button"><XCircle size={14} /> Reject</button></div>;
}

function InlineConfirmation({ busy, onCancel, onConfirm }) {
  return <div className="work-inline-confirm" role="alertdialog" aria-label="确认取消 Work"><AlertTriangle size={18} /><div><strong>确认取消 Work？</strong><span>取消会通过确定性 transition gate 写回并保留审计。</span></div><button disabled={busy} onClick={onCancel} type="button">Keep Work</button><button className="danger" disabled={busy} onClick={onConfirm} type="button">{busy ? 'Submitting…' : 'Confirm cancel'}</button></div>;
}

function ReviewDialog({ action, busy, comment, onCancel, onChange, onConfirm }) {
  const commentRequired = action === 'reject' || action === 'request_changes';
  return <div className="modal-overlay work-dialog-overlay"><form className="work-review-dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}><span>DETERMINISTIC ACCEPTANCE GATE</span><h2>{reviewTitle(action)}</h2><p>结论写回 Issue authority，并保留验证审计。</p><label><span>Review note {commentRequired ? '(required)' : '(optional)'}</span><textarea autoFocus className="form-control" onChange={event => onChange(event.target.value)} rows={5} value={comment} /></label><div><button disabled={busy} onClick={onCancel} type="button">Cancel</button><button className={action === 'reject' ? 'danger' : 'primary'} disabled={busy || (commentRequired && !comment.trim())} type="submit">{busy ? 'Submitting…' : 'Submit review'}</button></div></form></div>;
}

function fulfilledItems(result) {
  if (result.status !== 'fulfilled') return [];
  if (Array.isArray(result.value)) return result.value;
  return result.value?.items || [];
}

function settledErrors(results, keys) {
  return Object.fromEntries(results.flatMap((result, index) => result.status === 'rejected' ? [[keys[index], result.reason?.message || `Failed to load ${keys[index]}`]] : []));
}

function reviewTitle(action) {
  if (action === 'accept') return 'Accept Work delivery';
  if (action === 'reject') return 'Reject Work delivery';
  return 'Request changes';
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

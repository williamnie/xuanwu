import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  CircleDot,
  FileCheck2,
  GitBranch,
  Link2,
  LoaderCircle,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  XCircle,
} from 'lucide-react';
import { assistantApi } from '../api/assistant.js';
import { evidenceApi } from '../api/evidence.js';
import { handoffsApi } from '../api/handoffs.js';
import { runsApi } from '../api/runs.js';
import { workApi } from '../api/work.js';
import EvidencePanel from '../components/EvidencePanel.jsx';
import MarkdownPreview from '../components/editor/MarkdownPreview.jsx';
import { message } from '../store/toastStore.js';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import { issueIdFromWorkId } from './workBoardModel.js';
import {
  WORK_TIMELINE_KINDS,
  buildWorkActionPayload,
  filterTimelineItems,
  mergeTimelinePages,
  workAttentionSignals,
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
  issue_event: 'Issue compatibility',
  run: 'Run',
  work_event: 'Work audit',
};

const EMPTY_RESOURCES = {
  alerts: [],
  evidence: [],
  handoffs: [],
  runs: [],
  timeline: [],
  timelineCursor: '',
};

export default function WorkDetail({ navigateTo, onPageContextChange, onWorkChanged, projects = [], workId }) {
  const requestVersion = useRef(0);
  const [detail, setDetail] = useState(null);
  const [resources, setResources] = useState(EMPTY_RESOURCES);
  const [resourceErrors, setResourceErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineKind, setTimelineKind] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [reviewAction, setReviewAction] = useState('');
  const [reviewComment, setReviewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async ({ silent = false } = {}) => {
    const version = ++requestVersion.current;
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const nextDetail = await workApi.getWork(workId);
      if (version !== requestVersion.current) return;
      setDetail(nextDetail);
      const work = nextDetail?.work;
      const issueId = issueIdFromWorkId(work?.id);
      const projectId = work?.owner?.project_id || '';
      const settled = await Promise.allSettled([
        workApi.getWorkTimeline(workId, { limit: 60 }),
        runsApi.getRuns({ page: 1, pageSize: 100, workId }),
        evidenceApi.listEvidence({ limit: 100, workId }),
        handoffsApi.getHandoffs({ limit: 100, workId }),
        assistantApi.getPiGuardianAlerts({ projectId, status: 'open' }),
      ]);
      if (version !== requestVersion.current) return;
      const [timelineResult, runsResult, evidenceResult, handoffsResult, alertsResult] = settled;
      const nextResources = {
        alerts: fulfilledItems(alertsResult).filter(alert => !issueId || Number(alert.issue_id) === issueId),
        evidence: fulfilledItems(evidenceResult),
        handoffs: fulfilledItems(handoffsResult),
        runs: fulfilledItems(runsResult),
        timeline: timelineResult.status === 'fulfilled' ? timelineResult.value?.items || [] : [],
        timelineCursor: timelineResult.status === 'fulfilled' ? timelineResult.value?.next_cursor || '' : '',
      };
      setResources(nextResources);
      setResourceErrors(settledErrors(settled));
    } catch (loadError) {
      if (version === requestVersion.current) setError(loadError.message || '加载 Work 详情失败');
    } finally {
      if (version === requestVersion.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [workId]);

  useEffect(() => {
    setDetail(null);
    setResources(EMPTY_RESOURCES);
    setTimelineKind('');
    setEditorOpen(false);
    setPendingAction('');
    setReviewAction('');
    setReviewComment('');
    load();
  }, [load]);

  const work = detail?.work || null;
  const relations = useMemo(() => detail?.relations?.items || [], [detail]);
  const issueId = issueIdFromWorkId(work?.id);
  const projectName = projects.find(project => project.id === work?.owner?.project_id)?.name || work?.owner?.project_id || 'Unscoped';
  const availableActions = workAvailableActions(work?.status);
  const attention = useMemo(
    () => workAttentionSignals(work, relations, resources.timeline, resources.alerts),
    [relations, resources.alerts, resources.timeline, work],
  );
  const visibleTimeline = useMemo(
    () => filterTimelineItems(resources.timeline, timelineKind),
    [resources.timeline, timelineKind],
  );

  useEffect(() => {
    if (!work) return;
    onPageContextChange?.({
      page_id: 'work',
      project_id: work.owner?.project_id || '',
      work_id: work.id,
    });
  }, [onPageContextChange, work]);

  const loadMoreTimeline = async () => {
    if (!resources.timelineCursor || timelineLoading) return;
    setTimelineLoading(true);
    try {
      const response = await workApi.getWorkTimeline(workId, { cursor: resources.timelineCursor, limit: 60 });
      setResources(current => ({
        ...current,
        timeline: mergeTimelinePages(current.timeline, response?.items || []),
        timelineCursor: response?.next_cursor || '',
      }));
      setResourceErrors(current => ({ ...current, timeline: '' }));
    } catch (timelineError) {
      setResourceErrors(current => ({ ...current, timeline: timelineError.message || '加载更多时间线失败' }));
    } finally {
      setTimelineLoading(false);
    }
  };

  const submitAction = async (action) => {
    if (!work || submitting) return;
    setSubmitting(true);
    try {
      await workApi.controlWork(work.id, action, buildWorkActionPayload(work, action));
      message.success(action === 'enqueue' ? 'Work 已开始排队' : action === 'retry' ? 'Work 已重新排队' : 'Work 已取消');
      setPendingAction('');
      await load({ silent: true });
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
      await load({ silent: true });
      onWorkChanged?.();
    } catch (reviewError) {
      message.error(reviewError.message || 'Work 验收失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !work) return <WorkDetailLoading />;

  if (error || !work) {
    return (
      <section className="work-detail-failure" role="alert">
        <AlertTriangle size={22} />
        <div><strong>Work Detail 暂不可用</strong><span>{error || '找不到请求的 Work。'}</span></div>
        <button onClick={() => navigateTo('work')} type="button"><ArrowLeft size={14} /> 返回 Work Board</button>
      </section>
    );
  }

  return (
    <section className="work-detail-page animate-fade-in">
      <div className="work-detail-toolbar">
        <button className="work-detail-back" onClick={() => navigateTo('work')} type="button"><ArrowLeft size={15} /> Work Board</button>
        <div className="work-detail-actions">
          {availableActions.edit ? <button onClick={() => setEditorOpen(true)} type="button"><Pencil size={14} /> Edit</button> : null}
          {availableActions.start ? <button className="primary" disabled={submitting} onClick={() => submitAction('enqueue')} type="button"><Play size={14} /> Start</button> : null}
          {availableActions.retry ? <button className="primary" disabled={submitting} onClick={() => submitAction('retry')} type="button"><RotateCw size={14} /> Retry</button> : null}
          {availableActions.cancel ? <button className="danger" disabled={submitting} onClick={() => setPendingAction('cancel')} type="button"><Square size={13} /> Cancel</button> : null}
          <button disabled={refreshing} onClick={() => load({ silent: true })} type="button"><RefreshCw className={refreshing ? 'is-spinning' : ''} size={14} /> Refresh</button>
        </div>
      </div>

      <header className="work-detail-hero">
        <div className="work-detail-hero-main">
          <div className="work-detail-eyebrow"><CircleDot size={13} /> Canonical Work</div>
          <div className="work-detail-title-row">
            <span className="work-detail-status" data-status={work.status}>{STATUS_LABELS[work.status] || work.status}</span>
            <h1>{work.title}</h1>
          </div>
          <div className="work-detail-meta">
            <span>{projectName}</span><span>{work.type}</span><span>Revision {work.revision}</span><span>Updated {formatTime(work.updated_at)}</span>
          </div>
        </div>
        <div className="work-detail-identity">
          <span>WORK ID</span>
          <code>{work.id}</code>
          {issueId ? (
            <button onClick={() => navigateTo('issues', issueId)} type="button">Issue #{issueId} compatibility <ArrowUpRight size={13} /></button>
          ) : null}
        </div>
      </header>

      <details className="work-detail-compatibility">
        <summary>Source of truth & migration contract</summary>
        <div>
          <span>Read authority <strong>{detail.compatibility?.read_authority || 'issues'}</strong></span>
          <span>Write authority <strong>{detail.compatibility?.write_authority || 'issues-via-work-adapter'}</strong></span>
          <span>Dual read <strong>{detail.compatibility?.dual_read || 'none'}</strong></span>
          <span>Target shadow <strong>{detail.compatibility?.target_shadow || 'disabled'}</strong></span>
          <span>Rollback <strong>{detail.compatibility?.rollback || 'unregister Work routes without migration'}</strong></span>
          <span>Final deletion gate <strong>{detail.compatibility?.final_removal_gate || 'P11/G7/zero consumer/restore window'}</strong></span>
        </div>
      </details>

      <nav className="work-detail-section-nav" aria-label="Work detail sections">
        {['goal', 'acceptance', 'relationships', 'attention', 'runs', 'evidence', 'handoffs', 'timeline'].map(section => (
          <a href={`#work-${section}`} key={section}>{section}</a>
        ))}
      </nav>

      {pendingAction ? (
        <InlineConfirmation
          busy={submitting}
          onCancel={() => setPendingAction('')}
          onConfirm={() => submitAction(pendingAction)}
          text="取消会通过确定性 Work transition gate 写回 Issue authority，并保留审计事件。"
          title="确认取消 Work？"
        />
      ) : null}

      <section className="work-detail-goal work-detail-panel" id="work-goal">
        <SectionHeading eyebrow="Intent" title="Goal" />
        <MarkdownPreview text={work.goal || 'No goal recorded.'} />
      </section>

      <div className="work-detail-overview-grid">
        <section className="work-detail-panel" id="work-acceptance">
          <SectionHeading eyebrow={`Contract v${work.acceptance?.version || '?'}`} title="Acceptance" />
          <div className="work-acceptance-summary">
            <span><FileCheck2 size={15} /> {work.acceptance?.completion_rule === 'all_required' ? 'All required criteria' : work.acceptance?.completion_rule}</span>
            <span><GitBranch size={15} /> {work.acceptance?.requires_handoff ? 'Ready Handoff required' : 'No Handoff required'}</span>
          </div>
          <div className="work-acceptance-list">
            {(work.acceptance?.criteria || []).map(criterion => (
              <article key={criterion.id}>
                <CheckCircle2 size={15} />
                <div><strong>{criterion.description}</strong><code>{criterion.verification_policy_ref}</code></div>
                <span>{criterion.required ? 'Required' : 'Optional'}</span>
              </article>
            ))}
          </div>
          <div className="work-section-facts">
            <span>{resources.evidence.filter(item => item.status === 'passed').length} passed Evidence</span>
            <span>{resources.handoffs.filter(item => ['ready', 'delivered'].includes(item.status)).length} ready Handoff</span>
          </div>
          {availableActions.review ? <ReviewActions disabled={submitting} onSelect={setReviewAction} /> : null}
        </section>

        <section className="work-detail-panel" id="work-relationships">
          <SectionHeading eyebrow="Carrier projection" title="Relationships" />
          {relations.length > 0 ? (
            <div className="work-relationship-list">
              {relations.map(relation => (
                <article key={relation.relation_id}>
                  <Link2 size={15} />
                  <div><strong>{relation.kind}</strong><span>{relation.source_ref?.authority || 'carrier'} · {relation.source_ref?.external_id || relation.relation_id}</span></div>
                  <em data-status={relation.lifecycle}>{relation.lifecycle}</em>
                </article>
              ))}
            </div>
          ) : <EmptySection text="No Action, Delegation or Watch carrier is linked to this Work." />}
        </section>

        <section className="work-detail-panel" id="work-attention">
          <SectionHeading eyebrow="Deterministic signals" title="Attention" />
          {attention.length > 0 ? (
            <div className="work-attention-list">
              {attention.map(item => (
                <article key={item.id}>
                  <BellRing size={15} />
                  <div><strong>{item.title}</strong><span>{item.detail}</span></div>
                  <em>{item.status}</em>
                </article>
              ))}
            </div>
          ) : <EmptySection success text="No open Work, approval or Guardian attention signal." />}
          <button className="work-section-link" onClick={() => navigateTo('attention-inbox')} type="button">Open Attention <ArrowUpRight size={13} /></button>
        </section>
      </div>

      <section className="work-detail-panel" id="work-runs">
        <SectionHeading eyebrow={`${resources.runs.length} attempts`} title="Runs" />
        <ResourceError error={resourceErrors.runs} />
        {resources.runs.length > 0 ? (
          <div className="work-run-grid">
            {resources.runs.map(run => (
              <article key={run.id}>
                <div><span>Attempt {run.sequence || run.attempt_count || '?'}</span><em data-status={run.status}>{run.status}</em></div>
                <strong>{run.progress?.latest?.summary || run.legacy?.error || run.trigger || 'No progress summary yet.'}</strong>
                <span>{run.provider || 'provider unknown'} · {formatTime(run.started_at)}</span>
                <button onClick={() => navigateTo('runs', null, run.id)} type="button">Open Run <ArrowUpRight size={12} /></button>
              </article>
            ))}
          </div>
        ) : <EmptySection text="No Run has been materialized for this Work." />}
      </section>

      <section className="work-detail-evidence" id="work-evidence">
        <EvidencePanel title="Work Evidence" workId={work.id} />
      </section>

      <section className="work-detail-panel" id="work-handoffs">
        <SectionHeading eyebrow={`${resources.handoffs.length} deliveries`} title="Handoffs" />
        <ResourceError error={resourceErrors.handoffs} />
        {resources.handoffs.length > 0 ? (
          <div className="work-handoff-list">
            {resources.handoffs.map(handoff => (
              <article key={handoff.id}>
                <div><strong>{handoff.summary}</strong><em data-status={handoff.delivery_status?.overall || handoff.status}>{handoff.delivery_status?.overall || handoff.status}</em></div>
                <p>{handoff.notification_summary || handoff.next_step}</p>
                <span>{handoff.changed_file_count || 0} files · {handoff.evidence_count || 0} Evidence · {handoff.risk_count || 0} risks</span>
                <button onClick={() => navigateTo('handoffs', null, '', handoff.id)} type="button">Open Handoff <ArrowUpRight size={12} /></button>
              </article>
            ))}
          </div>
        ) : <EmptySection text="No Handoff has been prepared for this Work." />}
      </section>

      <section className="work-detail-panel" id="work-timeline">
        <SectionHeading eyebrow="Unified event projection" title="Timeline" />
        <div className="work-timeline-filters" role="group" aria-label="Timeline kind">
          <button aria-pressed={!timelineKind} onClick={() => setTimelineKind('')} type="button">All</button>
          {WORK_TIMELINE_KINDS.map(kind => (
            <button aria-pressed={timelineKind === kind} key={kind} onClick={() => setTimelineKind(kind)} type="button">
              {TIMELINE_LABELS[kind] || kind}
            </button>
          ))}
        </div>
        <ResourceError error={resourceErrors.timeline} />
        {visibleTimeline.length > 0 ? (
          <div className="work-timeline-list">
            {visibleTimeline.map(item => (
              <article key={item.id}>
                <span className="work-timeline-marker" data-kind={item.kind} />
                <div>
                  <div><strong>{item.title}</strong><em>{item.status}</em></div>
                  <p>{item.summary}</p>
                  <span>{TIMELINE_LABELS[item.kind] || item.kind} · {item.source?.authority || 'projection'} · {formatTime(item.occurred_at)}</span>
                </div>
              </article>
            ))}
          </div>
        ) : <EmptySection text={timelineKind ? 'No timeline event matches this kind.' : 'No Work timeline event recorded.'} />}
        {resources.timelineCursor ? (
          <button className="work-timeline-more" disabled={timelineLoading} onClick={loadMoreTimeline} type="button">
            {timelineLoading ? <LoaderCircle className="is-spinning" size={14} /> : null}{timelineLoading ? 'Loading…' : 'Load earlier events'}
          </button>
        ) : null}
      </section>

      {editorOpen ? (
        <WorkEditorDialog
          mode="edit"
          onClose={() => setEditorOpen(false)}
          onSaved={async () => {
            setEditorOpen(false);
            await load({ silent: true });
            onWorkChanged?.();
          }}
          projects={projects}
          work={work}
        />
      ) : null}

      {reviewAction ? (
        <ReviewDialog
          action={reviewAction}
          busy={submitting}
          comment={reviewComment}
          onCancel={() => {
            setReviewAction('');
            setReviewComment('');
          }}
          onChange={setReviewComment}
          onConfirm={submitReview}
        />
      ) : null}
    </section>
  );
}

function WorkDetailLoading() {
  return <div className="work-detail-loading"><LoaderCircle className="is-spinning" size={26} /><strong>Loading canonical Work…</strong></div>;
}

function SectionHeading({ eyebrow, title }) {
  return <header className="work-section-heading"><span>{eyebrow}</span><h2>{title}</h2></header>;
}

function EmptySection({ success = false, text }) {
  return <div className={`work-section-empty ${success ? 'success' : ''}`}>{success ? <CheckCircle2 size={16} /> : <CircleDot size={16} />}<span>{text}</span></div>;
}

function ResourceError({ error }) {
  return error ? <div className="work-resource-error" role="alert"><AlertTriangle size={14} /> {error}</div> : null;
}

function ReviewActions({ disabled, onSelect }) {
  return (
    <div className="work-review-actions">
      <button disabled={disabled} onClick={() => onSelect('accept')} type="button"><CheckCircle2 size={14} /> Accept</button>
      <button disabled={disabled} onClick={() => onSelect('request_changes')} type="button"><RefreshCw size={14} /> Request changes</button>
      <button className="danger" disabled={disabled} onClick={() => onSelect('reject')} type="button"><XCircle size={14} /> Reject</button>
    </div>
  );
}

function InlineConfirmation({ busy, onCancel, onConfirm, text, title }) {
  return (
    <div className="work-inline-confirm" role="alertdialog" aria-label={title}>
      <AlertTriangle size={18} />
      <div><strong>{title}</strong><span>{text}</span></div>
      <button disabled={busy} onClick={onCancel} type="button">Keep Work</button>
      <button className="danger" disabled={busy} onClick={onConfirm} type="button">{busy ? 'Submitting…' : 'Confirm cancel'}</button>
    </div>
  );
}

function ReviewDialog({ action, busy, comment, onCancel, onChange, onConfirm }) {
  const commentRequired = action === 'reject' || action === 'request_changes';
  return (
    <div className="modal-overlay work-dialog-overlay">
      <form className="work-review-dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
        <span>DETERMINISTIC ACCEPTANCE GATE</span>
        <h2>{reviewTitle(action)}</h2>
        <p>结论写回 Issue authority，并保留 verification intent、outcome 与人工证据事件。</p>
        <label>
          <span>Review note {commentRequired ? '(required)' : '(optional)'}</span>
          <textarea autoFocus className="form-control" onChange={event => onChange(event.target.value)} rows={5} value={comment} />
        </label>
        <div>
          <button disabled={busy} onClick={onCancel} type="button">Cancel</button>
          <button className={action === 'reject' ? 'danger' : 'primary'} disabled={busy || (commentRequired && !comment.trim())} type="submit">
            {busy ? 'Submitting…' : 'Submit review'}
          </button>
        </div>
      </form>
    </div>
  );
}

function fulfilledItems(result) {
  if (result.status !== 'fulfilled') return [];
  if (Array.isArray(result.value)) return result.value;
  return result.value?.items || [];
}

function settledErrors(results) {
  const keys = ['timeline', 'runs', 'evidence', 'handoffs', 'alerts'];
  return Object.fromEntries(results.flatMap((result, index) => (
    result.status === 'rejected' ? [[keys[index], result.reason?.message || `Failed to load ${keys[index]}`]] : []
  )));
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
